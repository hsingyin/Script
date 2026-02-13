const $ = new Env('ServerCard')

let arg = {}
if (typeof $argument != 'undefined') {
  arg = Object.fromEntries($argument.split('&').map(item => item.split('=').map(decodeURIComponent)))
}
$.log(`传入的 $argument: ${$.toStr(arg)}`)

const NEZHA_URL = arg.url?.replace(/\/+$/, "") || ""
const SERVER_ID = arg.id || ""
const NEZHA_USER = arg.user || ""
const NEZHA_PASS = arg.pass || ""

// 显示控制开关（1=显示 0=隐藏）
const SHOW_CPU = arg.cpu !== "0"
const SHOW_MEM = arg.mem !== "0"
const SHOW_DISK = arg.disk !== "0"
const SHOW_IP = arg.ip !== "0"
const SHOW_IPV6 = arg.ipv6 === "1"
const SHOW_AREA = arg.area !== "0"
const SHOW_ONLINE = arg.online !== "0"
const SHOW_TRAFFIC = arg.traffic !== "0"

// 自定义图标和颜色
const ICON = arg.icon || "server.rack"
const ICON_COLOR = arg["icon-color"] || "#6EC177"

const STORE_KEY = "server_card_jwt_token"

if (!NEZHA_URL || !SERVER_ID) {
  $done({
    title: "服务器状态 ❌",
    content: "请配置哪吒监控地址和服务器 ID",
    icon: "xmark.circle",
    "icon-color": "#CB1B45",
  })
}

if (!NEZHA_USER || !NEZHA_PASS) {
  $done({
    title: "服务器状态 ❌",
    content: "请配置用户名和密码",
    icon: "xmark.circle",
    "icon-color": "#CB1B45",
  })
}

// 主流程
;(async () => {
  try {
    const token = await getToken()
    await fetchServerStatus(token)
  } catch (e) {
    $.logErr(e)
    $done({
      title: "服务器状态 ❌",
      content: `${e.message || e}`,
      icon: "exclamationmark.triangle",
      "icon-color": "#CB1B45",
    })
  }
})()

/**
 * 获取可用的 JWT Token
 * 优先使用直接配置的 token，否则尝试缓存的 token，最后用用户名密码登录
 */
function getToken() {
  return new Promise((resolve, reject) => {
    // 尝试读取缓存的 token
    const cached = $.getval(STORE_KEY)
    if (cached) {
      $.log(`使用缓存的 token`)
      return resolve(cached)
    }

    // 用户名密码登录
    $.log(`缓存无 token，开始登录`)
    login()
      .then(resolve)
      .catch(reject)
  })
}

/**
 * 通过用户名密码登录获取 JWT Token
 */
function login() {
  return new Promise((resolve, reject) => {
    $httpClient.post(
      {
        url: `${NEZHA_URL}/api/v1/login`,
        headers: { "Content-Type": "application/json", "X-Client-Id": "surge" },
        body: JSON.stringify({ username: NEZHA_USER, password: NEZHA_PASS }),
        timeout: 10,
      },
      (error, response, data) => {
        if (error) {
          $.logErr(`登录请求失败: ${error}`)
          return reject(new Error(`登录失败: ${error}`))
        }
        try {
          const json = JSON.parse(data)
          if (!json.success || !json.data?.token) {
            $.logErr(`登录响应异常: ${data}`)
            return reject(new Error(`登录失败: ${json.error || "用户名或密码错误"}`))
          }
          const token = json.data.token
          // 缓存 token
          $.setval(token, STORE_KEY)
          $.log(`登录成功，token 已缓存`)
          resolve(token)
        } catch (e) {
          $.logErr(`登录响应解析失败: ${e.message}`)
          reject(new Error(`登录响应解析失败: ${e.message}`))
        }
      }
    )
  })
}

/**
 * 使用 token 获取服务器状态，若 token 过期则自动重新登录重试
 */
function fetchServerStatus(token) {
  return new Promise((resolve, reject) => {
    const API_URL = `${NEZHA_URL}/api/v1/server?id=${SERVER_ID}`;
    $httpClient.get(
      {
        url: API_URL,
        headers: {
          Cookie: `nz-jwt=${token}`,
          "Content-Type": "application/json",
          "X-Client-Id": "surge"
        },
        timeout: 10,
      },
      (error, response, data) => {
        if (error) {
          $.logErr(`请求服务器状态失败: ${error}`)
          return reject(new Error(`请求失败: ${error}`))
        }

        // 检测认证失败（HTTP 状态码或响应体中的错误）
        let isUnauthorized = response.status === 401 || response.status === 403;
        if (!isUnauthorized) {
          try {
            const check = JSON.parse(data);
            if (check.error && /unauthorized/i.test(check.error)) isUnauthorized = true;
          } catch (_) {}
        }

        if (isUnauthorized) {
          // 清除缓存的无效 token
          $.log(`Token 已失效，清除缓存并重新登录`)
          $.setval("", STORE_KEY)
          // 重新登录后重试
          login()
            .then((newToken) => {
              fetchServerStatusOnce(newToken).then(resolve).catch(reject);
            })
            .catch(reject);
          return;
        }

        renderPanel(data, reject, resolve);
      }
    );
  });
}

/**
 * 单次请求（重试用，不再处理 401）
 */
function fetchServerStatusOnce(token) {
  return new Promise((resolve, reject) => {
    const API_URL = `${NEZHA_URL}/api/v1/server?id=${SERVER_ID}`;
    $httpClient.get(
      {
        url: API_URL,
        headers: {
          Cookie: `nz-jwt=${token}`,
          "Content-Type": "application/json",
          "X-Client-Id": "surge"
        },
        timeout: 10,
      },
      (error, response, data) => {
        if (error) {
          $.logErr(`重试请求失败: ${error}`)
          return reject(new Error(`请求失败: ${error}`))
        }

        let isUnauthorized = response.status === 401 || response.status === 403;
        if (!isUnauthorized) {
          try {
            const check = JSON.parse(data);
            if (check.error && /unauthorized/i.test(check.error)) isUnauthorized = true;
          } catch (_) {}
        }
        if (isUnauthorized) {
          return reject(new Error("重新登录后仍认证失败，请检查用户名密码"));
        }

        renderPanel(data, reject, resolve);
      }
    );
  });
}

/**
 * 解析数据并渲染面板
 */
function renderPanel(data, reject, resolve) {
  try {
    const json = JSON.parse(data);
    if (!json.success || !json.data || json.data.length === 0) {
      return $done({
        title: "服务器状态 ❌",
        content: `未找到 ID 为 ${SERVER_ID} 的服务器`,
        icon: "questionmark.circle",
        "icon-color": "#F0C239",
      });
    }

    const server = json.data[0];
    const host = server.host || {};
    const state = server.state || {};
    const name = server.name || `Server #${SERVER_ID}`;

    // — 在线状态判断 —
    const lastActive = new Date(server.last_active);
    const now = new Date();
    const offlineThreshold = 60 * 1000;
    const isOnline = now - lastActive < offlineThreshold;

    if (!isOnline) {
      return $done({
        title: `${name} ⚫`,
        content: `LAST: ${formatTime(lastActive)}`,
        icon: ICON,
        "icon-color": "#8A8A8A",
      });
    }

    // — IP 信息 —
    const ipv4 = server.geoip?.ip?.ipv4_addr || "N/A";
    const ipv6 = server.geoip?.ip?.ipv6_addr || "N/A";
    const countryCode = server.geoip?.country_code?.toUpperCase() || "--";
    const countryFlag = getCountryFlag(countryCode);
    const area = countryFlag ? `${countryFlag} ${countryCode}` : countryCode;

    // — CPU —
    const cpuUsage = state.cpu?.toFixed(1) ?? "N/A";

    // — 内存 —
    const memUsed = state.mem_used ?? 0;
    const memTotal = host.mem_total ?? 1;
    const memPercent = ((memUsed / memTotal) * 100).toFixed(1);
    const memStr = `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`;

    // — 磁盘 —
    const diskUsed = state.disk_used ?? 0;
    const diskTotal = host.disk_total ?? 1;
    const diskPercent = ((diskUsed / diskTotal) * 100).toFixed(1);
    const diskStr = `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`;

    // — 流量 —
    const netIn = state.net_in_transfer ?? 0;
    const netOut = state.net_out_transfer ?? 0;

    // — 运行时间 —
    const uptime = formatUptime(state.uptime ?? 0);

    // — 根据开关参数动态生成面板内容 —
    const lines = [];
    if (SHOW_IP) {
      lines.push(`IP: ${ipv4}`);
    }
    if (SHOW_IPV6) {
      lines.push(`IPv6: ${ipv6}`);
    }
    if (SHOW_AREA) {
      lines.push(`AREA: ${area}`);
    }
    if (SHOW_CPU) {
      lines.push(`CPU: ${cpuUsage}%`);
    }
    if (SHOW_MEM) {
      lines.push(`MEM: ${memPercent}%(${memStr})`);
    }
    if (SHOW_DISK) {
      lines.push(`DISK: ${diskPercent}%(${diskStr})`);
    }
    if (SHOW_ONLINE) {
      lines.push(`ONLINE: ${uptime}`);
    }
    if (SHOW_TRAFFIC) {
      lines.push(`TRAFFIC: ↑ ${formatBytes(netOut)} / ↓ ${formatBytes(netIn)}`);
    }

    $done({
      title: `${name} 🟢`,
      content: lines.join("\n"),
      icon: ICON,
      "icon-color": ICON_COLOR,
    });
  } catch (e) {
    $.logErr(`解析面板数据失败: ${e.message}`)
    $done({
      title: "服务器状态 ❌",
      content: `解析失败: ${e.message}`,
      icon: "exclamationmark.triangle",
      "icon-color": "#CB1B45",
    })
  }
}

// ========== 工具函数 ==========

/**
 * 字节格式化 (自适应单位)
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const idx = Math.min(i, units.length - 1);
  return (bytes / Math.pow(k, idx)).toFixed(2) + " " + units[idx];
}

/**
 * 网速格式化 (字节/秒 → 自适应单位/s)
 */
function formatSpeed(bytesPerSec) {
  if (bytesPerSec === 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const k = 1024;
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  const idx = Math.min(i, units.length - 1);
  return (bytesPerSec / Math.pow(k, idx)).toFixed(2) + " " + units[idx];
}

/**
 * 运行时间格式化 (秒 → 天时分)
 */
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}时`);
  parts.push(`${m}分`);
  return parts.join("");
}

/**
 * 格式化时间显示
 */
function formatTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 根据国家代码获取国旗 Emoji
 */
function getCountryFlag(countryCode) {
  if (!countryCode || countryCode === "--") return "";
  const code = countryCode.toUpperCase();
  if (code.length !== 2) return "";
  const codePoints = [...code].map(c => 0x1F1E6 - 65 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// ========== Env 函数 ==========
// prettier-ignore
function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;return"POST"===e&&(s=this.post),new Promise((e,a)=>{s.call(this,t,(t,s,r)=>{t?a(t):e(s)})})}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.encoding="utf-8",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`🔔${this.name}, 开始!`)}getEnv(){return"undefined"!=typeof $environment&&$environment["surge-version"]?"Surge":"undefined"!=typeof $environment&&$environment["stash-version"]?"Stash":"undefined"!=typeof module&&module.exports?"Node.js":"undefined"!=typeof $task?"Quantumult X":"undefined"!=typeof $loon?"Loon":"undefined"!=typeof $rocket?"Shadowrocket":void 0}isNode(){return"Node.js"===this.getEnv()}isQuanX(){return"Quantumult X"===this.getEnv()}isSurge(){return"Surge"===this.getEnv()}isLoon(){return"Loon"===this.getEnv()}isShadowrocket(){return"Shadowrocket"===this.getEnv()}isStash(){return"Stash"===this.getEnv()}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null){try{return JSON.stringify(t)}catch{return e}}getjson(t,e){let s=e;const a=this.getdata(t);if(a)try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise(e=>{this.get({url:t},(t,s,a)=>e(a))})}runScript(t,e){return new Promise(s=>{let a=this.getdata("@chavy_boxjs_userCfgs.httpapi");a=a?a.replace(/\n/g,"").trim():a;let r=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");r=r?1*r:20,r=e&&e.timeout?e.timeout:r;const[i,o]=a.split("@"),n={url:`http://${o}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:r},headers:{"X-Key":i,Accept:"*/*"},timeout:r};this.post(n,(t,e,a)=>s(a))}).catch(t=>this.logErr(t))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),a=!s&&this.fs.existsSync(e);if(!s&&!a)return{};{const a=s?t:e;try{return JSON.parse(this.fs.readFileSync(a))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),a=!s&&this.fs.existsSync(e),r=JSON.stringify(this.data);s?this.fs.writeFileSync(t,r):a?this.fs.writeFileSync(e,r):this.fs.writeFileSync(t,r)}}lodash_get(t,e,s){const a=e.replace(/\[(\d+)\]/g,".$1").split(".");let r=t;for(const t of a)if(r=Object(r)[t],void 0===r)return s;return r}lodash_set(t,e,s){return Object(t)!==t?t:(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce((t,s,a)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[a+1])>>0==+e[a+1]?[]:{},t)[e[e.length-1]]=s,t)}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,a]=/^@(.*?)\.(.*?)$/.exec(t),r=s?this.getval(s):"";if(r)try{const t=JSON.parse(r);e=t?this.lodash_get(t,a,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,a,r]=/^@(.*?)\.(.*?)$/.exec(e),i=this.getval(a),o=a?"null"===i?null:i||"{}":"{}";try{const e=JSON.parse(o);this.lodash_set(e,r,t),s=this.setval(JSON.stringify(e),a)}catch(e){const i={};this.lodash_set(i,r,t),s=this.setval(JSON.stringify(i),a)}}else s=this.setval(t,e);return s}getval(t){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":return $persistentStore.read(t);case"Quantumult X":return $prefs.valueForKey(t);case"Node.js":return this.data=this.loaddata(),this.data[t];default:return this.data&&this.data[t]||null}}setval(t,e){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":return $persistentStore.write(t,e);case"Quantumult X":return $prefs.setValueForKey(t,e);case"Node.js":return this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0;default:return this.data&&this.data[e]||null}}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar))}get(t,e=(()=>{})){switch(t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"],delete t.headers["content-type"],delete t.headers["content-length"]),t.params&&(t.url+="?"+this.queryStr(t.params)),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,(t,s,a)=>{!t&&s&&(s.body=a,s.statusCode=s.status?s.status:s.statusCode,s.status=s.statusCode),e(t,s,a)});break;case"Quantumult X":this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:a,headers:r,body:i,bodyBytes:o}=t;e(null,{status:s,statusCode:a,headers:r,body:i,bodyBytes:o},i,o)},t=>e(t&&t.error||"UndefinedError"));break;case"Node.js":let s=require("iconv-lite");this.initGotEnv(t),this.got(t).on("redirect",(t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();s&&this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}}).then(t=>{const{statusCode:a,statusCode:r,headers:i,rawBody:o}=t,n=s.decode(o,this.encoding);e(null,{status:a,statusCode:r,headers:i,rawBody:o,body:n},n)},t=>{const{message:a,response:r}=t;e(a,r,r&&s.decode(r.rawBody,this.encoding))})}}post(t,e=(()=>{})){const s=t.method?t.method.toLocaleLowerCase():"post";switch(t.body&&t.headers&&!t.headers["Content-Type"]&&!t.headers["content-type"]&&(t.headers["content-type"]="application/x-www-form-urlencoded"),t.headers&&(delete t.headers["Content-Length"],delete t.headers["content-length"]),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient[s](t,(t,s,a)=>{!t&&s&&(s.body=a,s.statusCode=s.status?s.status:s.statusCode,s.status=s.statusCode),e(t,s,a)});break;case"Quantumult X":t.method=s,this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:a,headers:r,body:i,bodyBytes:o}=t;e(null,{status:s,statusCode:a,headers:r,body:i,bodyBytes:o},i,o)},t=>e(t&&t.error||"UndefinedError"));break;case"Node.js":let a=require("iconv-lite");this.initGotEnv(t);const{url:r,...i}=t;this.got[s](r,i).then(t=>{const{statusCode:s,statusCode:r,headers:i,rawBody:o}=t,n=a.decode(o,this.encoding);e(null,{status:s,statusCode:r,headers:i,rawBody:o,body:n},n)},t=>{const{message:s,response:r}=t;e(s,r,r&&a.decode(r.rawBody,this.encoding))})}}time(t,e=null){const s=e?new Date(e):new Date;let a={"M+":s.getMonth()+1,"d+":s.getDate(),"H+":s.getHours(),"m+":s.getMinutes(),"s+":s.getSeconds(),"q+":Math.floor((s.getMonth()+3)/3),S:s.getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,(s.getFullYear()+"").substr(4-RegExp.$1.length)));for(let e in a)new RegExp("("+e+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?a[e]:("00"+a[e]).substr((""+a[e]).length)));return t}queryStr(t){let e="";for(const s in t){let a=t[s];null!=a&&""!==a&&("object"==typeof a&&(a=JSON.stringify(a)),e+=`${s}=${a}&`)}return e=e.substring(0,e.length-1),e}msg(e=t,s="",a="",r){const i=t=>{switch(typeof t){case void 0:return t;case"string":switch(this.getEnv()){case"Surge":case"Stash":default:return{url:t};case"Loon":case"Shadowrocket":return t;case"Quantumult X":return{"open-url":t};case"Node.js":return}case"object":switch(this.getEnv()){case"Surge":case"Stash":case"Shadowrocket":default:{let e=t.url||t.openUrl||t["open-url"];return{url:e}}case"Loon":{let e=t.openUrl||t.url||t["open-url"],s=t.mediaUrl||t["media-url"];return{openUrl:e,mediaUrl:s}}case"Quantumult X":{let e=t["open-url"]||t.url||t.openUrl,s=t["media-url"]||t.mediaUrl,a=t["update-pasteboard"]||t.updatePasteboard;return{"open-url":e,"media-url":s,"update-pasteboard":a}}case"Node.js":return}default:return}};if(!this.isMute)switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:$notification.post(e,s,a,i(r));break;case"Quantumult X":$notify(e,s,a,i(r));break;case"Node.js":}if(!this.isMuteLog){let t=["","==============📣系统通知📣=============="];t.push(e),s&&t.push(s),a&&t.push(a),console.log(t.join("\n")),this.logs=this.logs.concat(t)}}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.join(this.logSeparator))}logErr(t,e){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":case"Quantumult X":default:this.log("",`❗️${this.name}, 错误!`,t);break;case"Node.js":this.log("",`❗️${this.name}, 错误!`,t.stack)}}wait(t){return new Promise(e=>setTimeout(e,t))}done(t={}){const e=(new Date).getTime(),s=(e-this.startTime)/1e3;switch(this.log("",`🔔${this.name}, 结束! 🕛 ${s} 秒`),this.log(),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":case"Quantumult X":default:$done(t);break;case"Node.js":process.exit(1)}}}(t,e)}