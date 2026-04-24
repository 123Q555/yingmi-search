const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = 'XzneU9pR87ST7AstXjToWw';
const SSE_URL = `https://stargate.yingmi.com/mcp/sse?apiKey=${API_KEY}`;
const PORT = process.env.PORT || 3456;

// ============================================================
// 持久 SSE 连接 + 消息队列
// ============================================================
let messageEndpoint = null;   // POST 目标路径
let sessionId = null;
let msgQueue = [];            // 收到的 JSON-RPC 响应
let msgWaiters = [];          // 等待中的 resolve 函数
let sseConnected = false;
let sseBuffer = '';
let sseReq = null;            // 当前 SSE 请求引用，用于主动销毁

// 重连相关
let reconnectTimer = null;
let reconnectDelay = 1000;    // 指数退避，初始 1s，最大 30s
let isReconnecting = false;   // 防止并发重连

// 心跳：定时发一个空 POST 保活（部分代理/防火墙会杀空闲连接）
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL = 25000; // 25 秒

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!sseConnected || !messageEndpoint) return;
    // 发一个空的 JSON-RPC notification 来保活 POST 通道
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} });
    const u = new URL(messageEndpoint);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    }, (res) => {
      // 消费响应但不需要处理
      res.resume();
    });
    req.on('error', (e) => {
      console.log(`[心跳] ping 失败: ${e.message}`);
    });
    req.write(body);
    req.end();
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (isReconnecting || reconnectTimer) return;
  isReconnecting = true;
  console.log(`[重连] ${reconnectDelay / 1000}s 后尝试重连…`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectSSE();
      await mcpInitialize();
      reconnectDelay = 1000; // 重连成功，重置退避
      isReconnecting = false;
      console.log('[重连] ✓ 重连成功');
    } catch (e) {
      isReconnecting = false;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      console.log(`[重连] ✗ 重连失败: ${e.message}，下次退避 ${reconnectDelay / 1000}s`);
      scheduleReconnect(); // 继续重试
    }
  }, reconnectDelay);
}

function connectSSE() {
  return new Promise((resolve, reject) => {
    const u = new URL(SSE_URL);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' }
    }, (res) => {
      sseReq = req;
      res.on('data', (chunk) => {
        sseBuffer += chunk.toString();
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop(); // 保留不完整的行

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            const data = line.substring(5).trim();
            handleSSEEvent(currentEvent, data);
            currentEvent = '';
          }
        }
      });
      res.on('end', () => {
        console.log('[SSE] 连接断开');
        sseConnected = false;
        messageEndpoint = null;
        sseReq = null;
        stopHeartbeat();
        // 自动重连
        scheduleReconnect();
      });
    });

    let currentEvent = '';
    req.on('error', (e) => {
      console.log('[SSE] 连接错误:', e.message);
      sseConnected = false;
      sseReq = null;
      stopHeartbeat();
      reject(e);
    });

    // 设置超时获取 endpoint
    const timeout = setTimeout(() => {
      if (!messageEndpoint) {
        req.destroy();
        reject(new Error('SSE endpoint 获取超时'));
      }
    }, 15000);

    // 覆盖 handleSSEEvent 来捕获 endpoint
    const origHandler = handleSSEEvent;
    handleSSEEvent = function (event, data) {
      if (event === 'endpoint' && !messageEndpoint) {
        // data 格式: /mcp/messages?sessionId=xxx
        messageEndpoint = data.startsWith('http')
          ? data
          : `https://stargate.yingmi.com${data}`;
        sessionId = data.split('sessionId=')[1] || '';
        sseConnected = true;
        clearTimeout(timeout);
        startHeartbeat(); // 启动心跳保活
        console.log(`[SSE] ✓ 已连接，sessionId: ${sessionId}`);
        handleSSEEvent = origHandler;
        resolve();
      } else {
        origHandler(event, data);
      }
    };

    req.end();
  });
}

function handleSSEEvent(event, data) {
  if (event === 'endpoint') return; // 已在 connect 中处理
  // message 事件或无事件名 = JSON-RPC 响应
  try {
    const parsed = JSON.parse(data);
    // 分发给等待中的 caller
    if (msgWaiters.length > 0) {
      const waiter = msgWaiters.shift();
      waiter(parsed);
    } else {
      msgQueue.push(parsed);
    }
  } catch (e) {
    // 非 JSON，忽略
  }
}

function postJSON(body) {
  return new Promise((resolve, reject) => {
    if (!messageEndpoint) {
      reject(new Error('MCP 未连接'));
      return;
    }
    const u = new URL(messageEndpoint);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve(buf); }
      });
    });
    req.on('error', (e) => {
      // POST 失败时标记连接不可用，触发重连
      console.log(`[MCP] POST 失败: ${e.message}`);
      sseConnected = false;
      messageEndpoint = null;
      stopHeartbeat();
      scheduleReconnect();
      reject(e);
    });
    req.write(data);
    req.end();
  });
}

function waitForMessage(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    // 先检查队列里有没有
    if (msgQueue.length > 0) {
      resolve(msgQueue.shift());
      return;
    }
    // 等待新消息
    const timer = setTimeout(() => {
      const idx = msgWaiters.indexOf(resolve);
      if (idx !== -1) msgWaiters.splice(idx, 1);
      reject(new Error('MCP 响应超时'));
    }, timeoutMs);

    msgWaiters.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

let msgIdCounter = 0;

// 等待重连完成（如果正在进行中）
async function waitForReconnect() {
  // 如果正在重连，等它结束
  while (isReconnecting) {
    await new Promise(r => setTimeout(r, 200));
  }
}

async function mcpCall(toolName, arguments_, timeoutMs = 30000) {
  // 确保连接
  if (!sseConnected) {
    // 如果正在重连，等它完成
    await waitForReconnect();
    // 如果还是没连上，主动连
    if (!sseConnected) {
      await connectSSE();
      await mcpInitialize();
    }
  }

  const id = ++msgIdCounter;

  // POST 调用
  await postJSON({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: arguments_ }
  });

  // 等待匹配的响应（可能需要跳过无关消息）
  for (let attempt = 0; attempt < 10; attempt++) {
    const msg = await waitForMessage(timeoutMs);
    if (msg.id === id) {
      return msg;
    }
    // 不匹配，跳过
    console.log(`[MCP] 跳过非目标消息 (期望 id=${id}, 收到 id=${msg.id})`);
  }
  throw new Error(`工具 ${toolName} 未返回有效结果`);
}

async function mcpInitialize() {
  // initialize
  await postJSON({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'yingmi-web', version: '1.0.0' }
    }
  });

  // notifications/initialized
  await postJSON({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  });

  // 消费掉 initialize 的响应
  await new Promise(r => setTimeout(r, 500));
  // 清空可能的初始化响应
  while (msgQueue.length > 0) {
    const msg = msgQueue.shift();
    console.log(`[MCP] 清理初始化响应: id=${msg.id}`);
  }

  console.log('[MCP] ✓ 初始化完成');
}

// ============================================================
// HTTP Server
// ============================================================
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 静态文件
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 状态接口 —— 方便前端/调试检查连接状态
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      connected: sseConnected,
      sessionId,
      isReconnecting,
      queueDepth: msgQueue.length
    }));
    return;
  }

  // 搜索接口
  if (url.pathname === '/api/search') {
    try {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const args = {};
          if (params.author) args.author = params.author;
          if (params.startDate) args.startDate = params.startDate;
          if (params.endDate) args.endDate = params.endDate;
          if (params.type) args.type = params.type;
          args.skip_attachment = true;

          // Split keywords by ；and search each
          const keywords = (params.keyword || '').split(/；/).map(s => s.trim()).filter(Boolean);
          const searchKeys = keywords.length > 0 ? keywords : [''];

          const seen = new Set();
          let allItems = [];

          for (const kw of searchKeys) {
            let pageNum = 1;
            let hasMore = true;
            const MAX_PAGES = 100;

            while (hasMore && pageNum <= MAX_PAGES) {
              const callArgs = { ...args, keyword: kw, page: pageNum, pageSize: 100 };
              try {
                const result = await mcpCall('searchInvestAdvisorContent', callArgs, 30000);

                if (result.result && result.result.content) {
                  const textContent = result.result.content.find(c => c.type === 'text');
                  if (textContent) {
                    const data = JSON.parse(textContent.text);
                    const items = data.items || [];
                    const apiTotal = data.total || 0;
                    const apiTotalPages = data.totalPages || 1;

                    if (pageNum === 1) {
                      console.log(`[search] keyword="${kw}" total=${apiTotal} pages=${apiTotalPages} page1=${items.length}条`);
                    }

                    for (const item of items) {
                      if (!seen.has(item.id)) {
                        seen.add(item.id);
                        allItems.push(item);
                      }
                    }

                    // 继续拉取：只要 API 报告还有更多页就继续
                    hasMore = pageNum < apiTotalPages;
                    pageNum++;
                    if (pageNum <= 3 || hasMore === false) {
                      console.log(`[search] page ${pageNum - 1}: ${items.length}条, total=${apiTotal}, pages=${apiTotalPages}, 继续=${hasMore}`);
                    }
                  } else {
                    hasMore = false;
                  }
                } else {
                  hasMore = false;
                }
              } catch (e) {
                console.log(`[search] page ${pageNum} error: ${e.message}`);
                hasMore = false;
              }
            }
          }

          console.log(`[search] 完成，共 ${allItems.length} 条去重结果`);

          // Exclusion filter
          const excludes = (params.excludeKeyword || '').split(/；/).map(s => s.trim()).filter(Boolean);
          if (excludes.length > 0) {
            allItems = allItems.filter(item => {
              const title = item.title.toLowerCase();
              return !excludes.some(ex => title.includes(ex.toLowerCase()));
            });
          }

          // 是否返回全量（用于复制全部）
          const returnAll = params.returnAll === true;

          // Paginate merged results
          const page = params.page || 1;
          const pageSize = params.pageSize || 20;
          const total = allItems.length;
          const totalPages = Math.ceil(total / pageSize) || 1;
          const start = (page - 1) * pageSize;
          const pageItems = returnAll ? allItems : allItems.slice(start, start + pageSize);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            items: pageItems,
            total,
            page: returnAll ? 1 : page,
            pageSize: returnAll ? total : pageSize,
            totalPages: returnAll ? 1 : totalPages
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 调试接口
  if (url.pathname === '/api/debug') {
    try {
      const kw = url.searchParams.get('keyword') || '';
      const page = parseInt(url.searchParams.get('page')) || 1;
      const pageSize = parseInt(url.searchParams.get('pageSize')) || 100;

      const result = await mcpCall('searchInvestAdvisorContent', {
        keyword: kw, page, pageSize, skip_attachment: true
      }, 30000);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  // 启动时预连接 SSE
  try {
    await connectSSE();
    await mcpInitialize();
    console.log('[启动] MCP 连接就绪');
  } catch (e) {
    console.log('[启动] MCP 预连接失败，将在首次搜索时重试:', e.message);
    scheduleReconnect();
  }
});
