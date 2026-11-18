import { randomBytes } from "node:crypto";

export function diagnosticsPage() {
  const nonce = randomBytes(18).toString("base64");
  const translations = {
    en: {
      title: "SceneSparrow diagnostics",
      explanation:
        "Private operational metadata. Read access expires automatically. Revoke it when support is finished.",
      status: "Refresh status",
      logs: "Read recent events",
      bundle: "Download safe bundle",
      mint: "Create / replace read grant (15 minutes)",
      revoke: "Revoke read grant",
      copy: "Copy token",
      scope:
        "Scope: diagnostics:read. The token is shown once and stays only in this page’s memory. Supply it as a Bearer header, never in a URL.",
      unavailable: "Diagnostics request failed",
      token: "Temporary token",
      empty: "No active token in this page",
      expires: "Expires",
      ready: "Ready",
    },
    "zh-CN": {
      title: "幕雀诊断",
      explanation:
        "仅包含私密运行元数据。只读授权会自动过期，支持结束后请撤销授权。",
      status: "刷新状态",
      logs: "读取近期事件",
      bundle: "下载安全诊断包",
      mint: "创建或替换只读授权（15 分钟）",
      revoke: "撤销只读授权",
      copy: "复制令牌",
      scope:
        "权限：diagnostics:read。令牌仅显示一次，仅保存在本页面内存中。请通过 Bearer 请求头提供，切勿放入网址。",
      unavailable: "诊断请求失败",
      token: "临时令牌",
      empty: "本页面没有活动令牌",
      expires: "到期时间",
      ready: "就绪",
    },
  };
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SceneSparrow diagnostics</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#f7f8fb;color:#172030}button,select{font:inherit;margin:.3rem;padding:.6rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem;border:1px solid #ccd3dd}input{width:95%;font:14px monospace;padding:.6rem}button:focus,input:focus{outline:3px solid #778ee0}</style><h1 data-i18n="title"></h1><select id="language" aria-label="Language"><option value="en">English</option><option value="zh-CN">简体中文</option></select><p data-i18n="explanation"></p><div><button id="status" data-i18n="status"></button><button id="logs" data-i18n="logs"></button><button id="bundle" data-i18n="bundle"></button></div><div><button id="mint" data-i18n="mint"></button><button id="revoke" data-i18n="revoke"></button></div><p data-i18n="scope"></p><label for="token" data-i18n="token"></label><input id="token" readonly autocomplete="off"><button id="copy" data-i18n="copy"></button><p id="expiry"></p><pre id="output" role="status" aria-live="polite"></pre><script nonce="${nonce}">
const texts=${JSON.stringify(translations)};let language=navigator.language.startsWith('zh')?'zh-CN':'en';let token='',expiresAt=0;const el=id=>document.getElementById(id);function localize(){document.documentElement.lang=language;document.title=texts[language].title;document.querySelectorAll('[data-i18n]').forEach(node=>node.textContent=texts[language][node.dataset.i18n]);el('language').value=language;if(!token)el('token').placeholder=texts[language].empty;}localize();el('language').onchange=()=>{language=el('language').value;localize();};async function api(path,method='GET',body){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);try{const response=await fetch('/diagnostics/v1/'+path,{method,credentials:'same-origin',cache:'no-store',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});const value=await response.json();if(!response.ok)throw new Error(value.code||texts[language].unavailable);return value;}finally{clearTimeout(timer);}}function display(value){el('output').textContent=JSON.stringify(value,null,2);}function action(id,fn){el(id).onclick=async()=>{el(id).disabled=true;try{await fn();}catch{el('output').textContent=texts[language].unavailable;}finally{el(id).disabled=false;}};}action('status',async()=>display(await api('status')));action('logs',async()=>display(await api('logs')));action('bundle',async()=>{const value=await api('bundle');const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='scenesparrow-diagnostics.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);});action('mint',async()=>{const value=await api('access-grants','POST',{ttlSeconds:900});token=value.token;expiresAt=Date.parse(value.expiresAt);el('token').value=token;el('expiry').textContent=texts[language].expires+': '+value.expiresAt;display({grantId:value.grantId,scope:value.scope,expiresAt:value.expiresAt});});function clearToken(){token='';expiresAt=0;el('token').value='';el('expiry').textContent='';localize();}action('revoke',async()=>{display(await api('access-grants/revoke','POST',{}));clearToken();});action('copy',async()=>{if(token)await navigator.clipboard.writeText(token);});setInterval(()=>{if(expiresAt&&Date.now()>=expiresAt)clearToken();},1000);addEventListener('pagehide',clearToken);el('output').textContent=texts[language].ready;
</script></html>`;
  return {
    html,
    csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
  };
}

export function authenticationPage(code, traceId, language) {
  const chinese = /^zh(?:-|,|;|$)/i.test(language ?? "");
  const message =
    code === "UNAUTHORIZED"
      ? chinese
        ? "请输入幕雀操作员用户名和密码，然后刷新页面。"
        : "Enter your SceneSparrow operator username and password, then refresh the page."
      : chinese
        ? "请求失败。请向操作员提供此跟踪标识。"
        : "The request failed. Give this trace identifier to the operator.";
  return `<!doctype html><html lang="${chinese ? "zh-CN" : "en"}"><meta charset="utf-8"><title>SceneSparrow</title><h1>SceneSparrow / 幕雀</h1><p>${message}</p><p>Trace: <code>${traceId}</code></p></html>`;
}
