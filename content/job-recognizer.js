// 岗位识别只读取当前职位的 DOM 元数据；不读取填写值、不请求外网、不提交表单。
(function (global) {
  'use strict';
  if (global.LocalApplyJobRecognizer) return;
  const A = global.LocalApplyApplications; let clickedAt = 0; let feedbackTimer; let lastFeedback = '';
  // 只取可见的岗位详情节点，排除导航、推荐列表和插件自身。
  function visible(element) { return !!element && !element.closest('aside,nav,[hidden],[aria-hidden="true"],[id^="wsa-"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'; }
  // 按明确选择器取得有界文本；不遍历表单值或整页正文。
  function pick(selector, limit = 500) { const element = [...document.querySelectorAll(selector)].slice(0, 60).find(visible); return element?.textContent?.trim().replace(/\s+/g, ' ').slice(0, limit) || ''; }
  // JSON-LD 可以是数组或 graph，但只接收有限层级和有限 JobPosting 数量。
  function postings(value, depth = 0) {
    if (!value || depth > 4) return [];
    if (Array.isArray(value)) return value.slice(0, 64).flatMap((item) => postings(item, depth + 1)).slice(0, 64);
    if (typeof value !== 'object') return [];
    if ([value['@type']].flat().includes('JobPosting')) return [value];
    return postings(value['@graph'], depth + 1);
  }
  // 结构化数据仅属于当前地址或明确 canonical 地址；不把推荐职位当作当前岗位。
  function currentPosting() {
    const current = A.cleanUrl(location.href); let canonical = current;
    try { const link = document.querySelector('link[rel="canonical"]')?.href; if (link && new URL(link).origin === location.origin) canonical = A.cleanUrl(link); } catch { /* 非法 canonical 不影响当前页面。 */ }
    const rows = [];
    for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 16)) {
      if (script.textContent.length > 256 * 1024) continue;
      try { rows.push(...postings(JSON.parse(script.textContent))); } catch { /* 不执行脚本，损坏 JSON 回退到局部 DOM。 */ }
    }
    const matching = rows.filter((row) => { try { return row.url && [current, canonical].includes(A.cleanUrl(new URL(row.url, location.href).href)); } catch { return false; } });
    if (matching.length === 1) return matching[0];
    return rows.length === 1 && !rows[0].url ? rows[0] : null;
  }
  // 优先读取 JobPosting，再使用职位详情的显式节点，缺失内容留给用户编辑。
  function inspect() {
    const structured = currentPosting(); const organization = structured?.hiringOrganization;
    const address = [structured?.jobLocation].flat().find((item) => item && typeof item === 'object')?.address;
    const scalar = (value, limit = 500) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
    // 页面标题只在明确岗位路径上作为末级候选，不从普通页面标题猜测公司。
    const titleFallback = /\/(?:jobs?|positions?|requisitions?)\/[a-z\d_-]+\/?$/i.test(location.pathname) ? document.title.split(/\s+[|｜·–—]\s+/)[0].trim().slice(0, 500) : '';
    const title = scalar(structured?.title) || pick('main [data-job-title],main [itemprop="title"],main .job-title,article .job-title,main h1,article h1,[data-job-title]') || titleFallback;
    const company = scalar(typeof organization === 'string' ? organization : organization?.name) || pick('main [data-company],main [itemprop="hiringOrganization"],main .company-name,article .company-name,[data-company]');
    const params = new URL(location.href).searchParams;
    const id = scalar(typeof structured?.identifier === 'string' ? structured.identifier : structured?.identifier?.value) || ['jobId', 'job_id', 'positionId', 'position_id', 'id'].map((key) => params.get(key)).find(Boolean) || location.pathname.match(/\/(?:jobs?|positions?|requisitions?)\/([a-z\d_-]+)\/?$/i)?.[1] || '';
    const locationText = scalar(address?.addressLocality) || scalar(address?.addressRegion) || scalar(typeof structured?.jobLocation === 'string' ? structured.jobLocation : '') || pick('main [data-job-location],main [itemprop="jobLocation"],main .job-location,article .job-location');
    const source = /moka/i.test(location.hostname) ? 'Moka' : /beisen|italent/i.test(location.hostname) ? '北森' : /feishu|lark/i.test(location.hostname) ? '飞书招聘' : location.hostname;
    const candidate = A.candidate({ companyName: company, jobTitle: title, jobUrl: location.href, jobId: scalar(id), jobSource: source, location: locationText,
      employmentType: scalar([structured?.employmentType].flat().filter((item) => typeof item === 'string').join(' / ')) || pick('main [data-job-type],main [itemprop="employmentType"],main .job-type'),
      summary: pick('main [data-job-description],main [itemprop="description"],main .job-description,article .job-description', 6000) });
    return { candidate, documentId: global.LocalApplyPageScanner?.documentId || '', feedback: feedback(), recognized: !!(title && (company || structured)) };
  }
  // 仅显式状态区中的成功提示可提出确认建议；失败提示优先，不搜索整页文字。
  function feedback() {
    const text = [...document.querySelectorAll('main [role="status"],main [role="alert"],[data-application-result],.application-success,.application-error')].slice(0, 30).filter(visible).map((element) => element.textContent.slice(0, 500)).join(' ');
    if (/投递失败|申请失败|提交失败|提交错误|认证失败|application failed|submission failed|\berror\b/i.test(text)) return 'failed';
    if (/投递成功|申请成功|提交成功|已成功申请|application (?:submitted|received)|successfully (?:applied|submitted)/i.test(text)) return 'success';
    return 'unknown';
  }
  // 反馈只发固定枚举；没有已授权的用户提交动作时，后台不会建立投递状态。
  function reportFeedback() {
    const status = feedback(); if (status === lastFeedback) return; lastFeedback = status;
    chrome.runtime.sendMessage({ type: 'jobs:feedback', status }).then((response) => { global.WangshenFloatbar?.onJobFeedback(status, response?.successSuggested); }).catch(() => {});
  }
  // 只记录用户真实点击提交，不能把页面脚本触发的自动提交当作用户投递。
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button,input[type="submit"]');
    if (event.isTrusted && button && visible(button) && button.closest('form') && (button.type === 'submit' || /投递|申请|提交|apply|submit/i.test(button.textContent || button.getAttribute('aria-label') || ''))) clickedAt = Date.now();
  }, true);
  // 只观察提交事件，不调用 preventDefault、不点击按钮，也不读取任何表单值。
  document.addEventListener('submit', (event) => {
    if (!event.isTrusted || Date.now() - clickedAt > 2000) return; clickedAt = 0;
    try { const snapshot = inspect(); chrome.runtime.sendMessage({ type: 'jobs:submitted', candidate: snapshot.candidate, documentId: snapshot.documentId, feedbackBefore: snapshot.feedback }).then(() => { lastFeedback = ''; reportFeedback(); }).catch(() => {}); } catch { /* 元数据无效时用户仍可手动记录。 */ }
  }, true);
  // 观察状态区域变化支持异步提交；合并通知并排除插件自身的更新。
  const observer = new MutationObserver((records) => { if (records.some((record) => !record.target.closest?.('[id^="wsa-"]')) && !feedbackTimer) feedbackTimer = setTimeout(() => { feedbackTimer = null; reportFeedback(); }, 250); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'aria-hidden'] });
  // 后台检查统一经过 detector 的可信消息入口，本模块不额外注册响应监听器。
  global.LocalApplyJobRecognizer = { inspect, feedback }; reportFeedback();
})(globalThis);
