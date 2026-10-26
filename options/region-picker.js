// 单输入地区选择器：仅使用本地地名，浏览和搜索不保存，确认后沿用字段保存链路。
(() => {
  'use strict';
  const provinces = ['北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区', '香港特别行政区', '澳门特别行政区', '台湾省', '海外/其他'];
  let index = null; let active = null;

  // 懒加载公共地名索引，按省/市/区顺序排列，不保存用户搜索词。
  function locations() {
    if (index) return index;
    index = []; const regions = globalThis.LocalApplyRegions || {};
    for (const province of provinces) {
      index.push([province]);
      for (const [city, districts] of Object.entries(regions[province] || {})) { index.push([province, city]); for (const district of districts) index.push([province, city, district]); }
    }
    return index;
  }
  // 多个中文关键词匹配完整路径，显示有界结果，并返回真实命中数量。
  function search(query) {
    const words = query.trim().split(/[\s/、，,]+/).filter(Boolean); if (!words.length) return { count: 0, paths: [] };
    const matches = locations().filter((path) => words.every((word) => path.join(' / ').includes(word)));
    return { count: matches.length, paths: matches.slice(0, 60) };
  }
  // 标签和手填文字一律用文本节点展示，不执行用户输入的 HTML。
  function node(tag, text = '', className = '') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
  // 关闭弹层恢复已确认内容，丢弃的仅是未选定的搜索文字。
  function close(restoreFocus = false) {
    if (!active) return;
    const previous = active; active = null; previous.controller.abort(); previous.observer.disconnect(); previous.popup.remove(); previous.restore();
    previous.input.setAttribute('aria-expanded', 'false'); previous.input.removeAttribute('aria-controls'); previous.input.removeAttribute('aria-activedescendant'); previous.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && previous.input.isConnected) previous.input.focus({ preventScroll: true });
  }
  // 单一内容框承担选择与搜索；value 只返回已确认值，避免搜索词被失焦自动保存。
  function create(label, value) {
    const box = node('div', '', 'workspace-region'); box.setAttribute('role', 'group'); const entry = node('div', '', 'region-picker-entry');
    const input = document.createElement('input'); input.type = 'text'; input.dataset.primary = ''; input.autocomplete = 'off';
    let current = value == null ? '' : String(value); input.value = current; input.placeholder = '选择地区或输入省、市、区县搜索';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-haspopup', 'listbox');
    const trigger = node('button', '⌄', 'region-picker-trigger'); trigger.type = 'button'; trigger.setAttribute('aria-label', '选择地区 · ' + label); trigger.setAttribute('aria-expanded', 'false');
    entry.append(input, trigger); box.append(entry); Object.defineProperty(box, 'value', { get: () => current });
    // 只有选择、路径确认、手填确认和清空才触发保存，不自动补齐未知地区。
    function commit(next) {
      const changed = current !== next; current = next; input.value = current; close(true);
      if (changed) { box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    // 点击展开联动候选，编辑内容框后改为搜索，不改动已保存值。
    function open(query = null) {
      if (input.disabled) return;
      if (active?.input === input) { active.query(query); return; }
      close(); const regions = globalThis.LocalApplyRegions || {}; const parts = current.split(/\s*\/\s*/);
      let path = provinces.includes(parts[0]) ? [parts[0]] : [];
      if (path.length && Object.hasOwn(regions[path[0]] || {}, parts[1])) path.push(parts[1]);
      let searching = query !== null && query.trim() !== ''; let text = query || ''; let options = []; let selected = -1;
      const popup = node('div', '', 'region-picker'); popup.setAttribute('popover', 'manual'); popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', '地区选择 · ' + label);
      const controller = new AbortController(); const { signal } = controller;
      // 切模块、收起选填区、禁用输入或重绘时清理弹层及其监听。
      const observer = new MutationObserver(() => { if (!input.isConnected || input.disabled || input.closest('[hidden]')) close(); });
      active = { input, trigger, popup, controller, observer, restore: () => { input.value = current; }, query: updateQuery };
      input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'region-picker-options'); trigger.setAttribute('aria-expanded', 'true');
      // 根据输入位置安放顶层弹窗，窄屏及底部空间不足时保持在视口内。
      function position() {
        const anchor = input.getBoundingClientRect(); const bounds = popup.getBoundingClientRect();
        if (anchor.bottom < 0 || anchor.top > innerHeight) { close(); return; }
        popup.style.left = Math.max(12, Math.min(anchor.left, innerWidth - bounds.width - 12)) + 'px';
        const below = anchor.bottom + 8; const above = anchor.top - bounds.height - 8;
        popup.style.top = (below + bounds.height <= innerHeight - 12 ? below : above >= 12 ? above : Math.max(12, innerHeight - bounds.height - 12)) + 'px';
      }
      // 方向键活动项与已保存地区分别标记，滚动只作用于候选列表。
      function activate(next) {
        selected = options.length ? Math.max(0, Math.min(options.length - 1, next)) : -1;
        popup.querySelectorAll('[role="option"]').forEach((option, i) => { option.classList.toggle('active', i === selected); });
        const option = popup.querySelectorAll('[role="option"]')[selected];
        if (option) { input.setAttribute('aria-activedescendant', option.id); const list = option.parentElement; if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop; else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight; }
        else input.removeAttribute('aria-activedescendant');
      }
      // 搜索结果直接确认；分级候选进入下一层，省或市也可单独确认。
      function choose(index) {
        const candidate = options[index]; if (!candidate) return;
        if (searching || candidate.length === 3) { commit(candidate.join(' / ')); return; }
        const children = candidate.length === 1 ? Object.keys(regions[candidate[0]] || {}) : regions[candidate[0]]?.[candidate[1]] || [];
        if (!children.length) { commit(candidate.join(' / ')); return; }
        path = candidate; render();
      }
      // 操作按钮均可聚焦，避免隐式表单提交。
      function button(title, handler, className = '') { const control = node('button', title, className); control.type = 'button'; control.addEventListener('click', handler); return control; }
      // 在同一弹层中切换分级或搜索，不再额外展示省份/城市输入行。
      function render() {
        popup.replaceChildren(); input.removeAttribute('aria-activedescendant');
        const header = node('div', '', 'region-picker-header'); header.append(node('strong', searching ? '搜索地区' : '选择' + ['省份', '城市', '区县'][path.length]));
        const closeButton = button('×', () => close(true), 'region-picker-close'); closeButton.setAttribute('aria-label', '关闭地区选择'); header.append(closeButton); popup.append(header);
        if (!searching) {
          const crumbs = node('nav', '', 'region-picker-crumbs'); crumbs.setAttribute('aria-label', '地区层级'); crumbs.append(button('全部省份', () => { path = []; render(); }));
          path.forEach((name, index) => { crumbs.append(node('span', '›'), button(name, () => { path = path.slice(0, index + 1); render(); })); }); popup.append(crumbs);
          options = path.length === 0 ? provinces.map((name) => [name]) : path.length === 1 ? Object.keys(regions[path[0]] || {}).map((name) => [...path, name]) : (regions[path[0]]?.[path[1]] || []).map((name) => [...path, name]);
        } else { const found = search(text); options = found.paths; popup.append(node('p', found.count ? '找到 ' + found.count + ' 个地区' + (found.count > 60 ? '，请细化搜索（显示前 60 项）' : '') : '未找到地区，可使用输入内容手动保存。', 'region-picker-hint')); }
        const list = node('div', '', 'region-picker-options' + (searching ? ' searching' : '')); list.id = 'region-picker-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '地区候选');
        options.forEach((candidate, index) => {
          const name = candidate.join(' / '); const option = button(searching ? name : candidate.at(-1), () => choose(index), 'region-picker-option'); option.id = 'region-option-' + index; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(name === current)); option.tabIndex = -1; option.title = name; list.append(option);
        }); popup.append(list);
        const footer = node('div', '', 'region-picker-footer'); footer.append(button('清空', () => commit(''), 'region-picker-clear'));
        if (!searching && path.length) footer.append(button('使用当前地区', () => commit(path.join(' / ')), 'region-picker-use'));
        if (searching) footer.append(button('使用输入内容', () => commit(text.trim()), 'region-picker-use'));
        popup.append(footer, node('p', '↑↓ 浏览 · 回车选择 · Ctrl+回车使用输入 · Esc 取消', 'region-picker-help')); position();
        const chosen = options.findIndex((candidate) => candidate.join(' / ') === current); activate(chosen >= 0 ? chosen : 0);
      }
      // 中文组合输入只筛选候选，不会提前确认或写入个人库。
      function updateQuery(next) { if (next === null) return; text = next; searching = text.trim() !== ''; render(); }
      popup.addEventListener('pointerdown', (event) => { if (event.target.closest('button[role="option"]')) event.preventDefault(); });
      box.append(popup); if (popup.showPopover) popup.showPopover(); render();
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
      document.addEventListener('pointerdown', (event) => { if (!box.contains(event.target)) close(); }, { capture: true, signal });
      document.addEventListener('focusin', (event) => { if (!box.contains(event.target)) close(); }, { signal });
      window.addEventListener('resize', position, { signal }); window.addEventListener('scroll', (event) => { if (!popup.contains(event.target)) position(); }, { capture: true, signal }); window.addEventListener('pagehide', () => close(), { signal });
      // 方向键只移动候选；回车确认，Esc 取消，离开输入区域也不保存搜索词。
      input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); activate(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : selected + (event.key === 'ArrowDown' ? 1 : -1)); }
        else if (event.key === 'Enter') { event.preventDefault(); if (event.ctrlKey || event.metaKey) commit(input.value.trim()); else if (selected >= 0) choose(selected); else if (searching) commit(input.value.trim()); }
        else if (event.key === 'Escape') { event.preventDefault(); close(true); }
      }, { signal });
    }
    input.addEventListener('input', (event) => { event.stopPropagation(); open(input.value); });
    input.addEventListener('change', (event) => event.stopPropagation()); input.addEventListener('click', () => open());
    input.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' && active?.input !== input) { event.preventDefault(); open(); } });
    trigger.addEventListener('click', () => { if (active?.input === input) close(true); else { input.focus({ preventScroll: true }); open(); } });
    return box;
  }
  globalThis.LocalApplyRegionPicker = Object.freeze({ search, create });
})();
