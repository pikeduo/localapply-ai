// 本地中文日历：仅管理日期选择和输入校验，保存仍由现有字段编辑器负责。
(() => {
  'use strict';
  let active = null;

  // 用 UTC 构造日历日期，避免时区偏移和 JavaScript 将 0～99 年解释为 1900 年。
  function calendarDate(year, month, day = 1) {
    const date = new Date(0); date.setUTCFullYear(year, month - 1, day); return date;
  }

  // 根据指定精度校验真实日期，不自动补齐缺失的月份或日期。
  function parse(value, mode) {
    const pattern = mode === 'year' ? /^(\d{4})$/ : mode === 'month' ? /^(\d{4})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})$/;
    const match = pattern.exec(value); if (!match) return null;
    const year = Number(match[1]); const month = Number(match[2] || 1); const day = Number(match[3] || 1);
    const date = calendarDate(year, month, day);
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? { year, month, day } : null;
  }

  // 输出统一存储格式；低精度值只包含用户实际选择的部分。
  function format(year, month, day, mode = 'date') {
    const parts = [String(year).padStart(4, '0')];
    if (mode !== 'year') parts.push(String(month).padStart(2, '0'));
    if (mode === 'date') parts.push(String(day).padStart(2, '0'));
    return parts.join('-');
  }

  // 生成六行日历及相邻月份日期，越过支持年份边界时保留空格。
  function monthDays(year, month) {
    const first = calendarDate(year, month); const offset = first.getUTCDay();
    return Array.from({ length: 42 }, (_, index) => {
      const date = calendarDate(year, month, index - offset + 1); const y = date.getUTCFullYear(); const m = date.getUTCMonth() + 1; const day = date.getUTCDate();
      return y < 1 || y > 9999 ? null : { year: y, month: m, day, value: format(y, m, day), currentMonth: m === month };
    });
  }

  // 安全构造日历节点，字段名称和日期从不作为 HTML 执行。
  function node(tag, text = '', className = '') {
    const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
  }

  // 切换字段或离开页面时移除弹层和本次监听，不保留每个字段的全局事件。
  function close(restoreFocus = false) {
    if (!active) return;
    const previous = active; active = null; previous.controller.abort(); previous.observer.disconnect();
    previous.popup.remove(); previous.trigger.setAttribute('aria-expanded', 'false'); previous.trigger.removeAttribute('aria-controls');
    if (restoreFocus && previous.input.isConnected) previous.input.focus({ preventScroll: true });
  }

  // 为单个日期输入绑定共享日历；精度由调用方实时提供，不读取或写入数据库。
  function attach(input, trigger, { mode, label, status }) {
    trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');

    // 手动输入继续使用相同保存事件；无效新日期留作草稿并提示，旧文本模式不改值。
    function validate() {
      const valid = mode() === 'legacy' || input.value === '' || !!parse(input.value, mode());
      const pattern = mode() === 'year' ? 'YYYY' : mode() === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
      status.textContent = valid ? '' : '请输入有效日期（' + pattern + '），或使用日历选择。'; status.hidden = valid;
      input.setCustomValidity(valid ? '' : status.textContent);
      if (valid) input.removeAttribute('aria-invalid'); else input.setAttribute('aria-invalid', 'true');
      return valid;
    }
    input.addEventListener('input', () => { validate(); if (active?.input === input) close(); });
    input.addEventListener('change', (event) => { if (!validate()) event.stopPropagation(); });

    // 打开时以已有选择或本机今天定位，浏览月份本身不会修改输入值。
    function open(focusGrid = true) {
      if (mode() === 'legacy') return;
      if (active?.input === input) { if (focusGrid) active.popup.querySelector('.date-picker-cell[tabindex="0"]')?.focus({ preventScroll: true }); return; }
      close();
      const today = new Date(); const now = { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() };
      const selected = parse(input.value, mode()); let cursor = { ...(selected || now) };
      let view = mode() === 'year' ? 'years' : mode() === 'month' ? 'months' : 'days';
      const popup = node('div', '', 'date-picker'); popup.id = 'localapply-date-picker'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', '日期选择 · ' + label); popup.setAttribute('popover', 'manual');
      const controller = new AbortController(); const { signal } = controller;
      // 表单重绘、切换模块或档案时关闭旧日历，避免继续编辑已脱离文档的输入。
      const observer = new MutationObserver(() => { if (!input.isConnected || input.closest('[hidden]')) close(); });
      active = { input, trigger, popup, controller, observer }; trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', popup.id);

      // 用视口坐标安放顶层弹窗，窄屏或底部空间不足时向内收拢。
      function position() {
        const anchor = input.getBoundingClientRect(); const bounds = popup.getBoundingClientRect();
        if (anchor.bottom < 0 || anchor.top > innerHeight) { close(); return; }
        const left = Math.max(12, Math.min(anchor.left, innerWidth - bounds.width - 12));
        const below = anchor.bottom + 8; const above = anchor.top - bounds.height - 8;
        const top = below + bounds.height <= innerHeight - 12 ? below : above >= 12 ? above : Math.max(12, innerHeight - bounds.height - 12);
        popup.style.left = left + 'px'; popup.style.top = top + 'px';
      }

      // 仅明确选择或清空才发送原有保存事件，取消及日期翻页不触碰个人值。
      function commit(value) {
        const changed = input.value !== value; input.value = value; validate(); close(true);
        if (changed) { input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
      }

      // 日历按钮统一提供类型及无障碍名称，避免误触发表单提交。
      function button(text, description, handler, className = '') {
        const control = node('button', text, className); control.type = 'button'; control.setAttribute('aria-label', description); control.title = description; control.addEventListener('click', handler); return control;
      }

      // 日期、月份和年份共用有界翻页，快速按钮分别跨年或跨年份区间。
      function move(direction, fast) {
        if (view === 'days') {
          const index = Math.max(0, Math.min(9999 * 12 - 1, (cursor.year - 1) * 12 + cursor.month - 1 + direction * (fast ? 12 : 1)));
          cursor.year = Math.floor(index / 12) + 1; cursor.month = index % 12 + 1;
        } else cursor.year = Math.max(1, Math.min(9999, cursor.year + direction * (view === 'years' ? fast ? 120 : 12 : fast ? 12 : 1)));
        render();
      }

      // 选中年份后按当前精度结束，或继续选月/日，不写入隐含的一月一日。
      function chooseYear(year) { cursor.year = year; if (mode() === 'year') commit(format(year, 1, 1, 'year')); else { view = 'months'; render(); } }

      // 月份精度直接保存月份；日精度继续展示当月的可选日期。
      function chooseMonth(month) { cursor.month = month; if (mode() === 'month') commit(format(cursor.year, month, 1, 'month')); else { view = 'days'; render(); } }

      // 日历面板只在打开后构建，所有候选通过真实按钮选择，支持明暗主题和键盘。
      function render() {
        popup.replaceChildren(); popup.dataset.view = view;
        const header = node('div', '', 'date-picker-header');
        const title = node('div', '', 'date-picker-title');
        const startYear = Math.floor((cursor.year - 1) / 12) * 12 + 1;
        title.append(button(view === 'years' ? startYear + ' – ' + Math.min(9999, startYear + 11) : cursor.year + ' 年', '选择年份', () => { view = 'years'; render(); }));
        if (view === 'days') title.append(button(cursor.month + ' 月', '选择月份', () => { view = 'months'; render(); }));
        const unit = view === 'days' ? '个月' : view === 'months' ? '一年' : '一组年份';
        header.append(button('«', view === 'days' ? '前一年' : view === 'years' ? '前一百二十年' : '前十二年', () => move(-1, true), 'date-picker-arrow'), button('‹', '上' + unit, () => move(-1, false), 'date-picker-arrow'), title, button('›', '下' + unit, () => move(1, false), 'date-picker-arrow'), button('»', view === 'days' ? '后一年' : view === 'years' ? '后一百二十年' : '后十二年', () => move(1, true), 'date-picker-arrow'));
        popup.append(header);
        if (view === 'days') {
          const weekdays = node('div', '', 'date-picker-weekdays'); weekdays.setAttribute('aria-hidden', 'true');
          ['日', '一', '二', '三', '四', '五', '六'].forEach((day) => weekdays.append(node('span', day))); popup.append(weekdays);
        }
        const grid = node('div', '', 'date-picker-grid ' + (view === 'days' ? 'date-picker-days' : 'date-picker-choices')); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', view === 'days' ? cursor.year + '年' + cursor.month + '月' : view === 'months' ? '月份' : '年份');
        // 候选只标记明确选中的精度，今天另用边框提示，空值不冒充已选日期。
        function cell(text, description, value, chosen, today, handler, adjacent = false) {
          const control = button(String(text), description, handler, 'date-picker-cell'); control.dataset.value = value; control.setAttribute('role', 'gridcell'); control.setAttribute('aria-selected', String(chosen)); control.tabIndex = -1;
          if (today) control.setAttribute('aria-current', 'date'); if (adjacent) control.classList.add('adjacent'); grid.append(control);
        }
        if (view === 'days') monthDays(cursor.year, cursor.month).forEach((day) => {
          if (!day) { grid.append(node('span')); return; }
          cell(day.day, day.year + '年' + day.month + '月' + day.day + '日', day.value, input.value === day.value, day.value === format(now.year, now.month, now.day), () => commit(day.value), !day.currentMonth);
        });
        else if (view === 'months') for (let month = 1; month <= 12; month++) {
          const value = format(cursor.year, month, 1, 'month'); cell(month + ' 月', cursor.year + '年' + month + '月', value, !!selected && selected.year === cursor.year && selected.month === month, now.year === cursor.year && now.month === month, () => chooseMonth(month));
        } else for (let year = startYear; year <= Math.min(9999, startYear + 11); year++) cell(year, year + '年', String(year), selected?.year === year, now.year === year, () => chooseYear(year));
        // 按可见列数建立无障碍行结构，方向键仍沿用整张网格的顺序。
        const candidates = [...grid.children]; const columns = view === 'days' ? 7 : 3;
        for (let index = 0; index < candidates.length; index += columns) { const row = node('div', '', 'date-picker-row'); row.setAttribute('role', 'row'); row.append(...candidates.slice(index, index + columns)); grid.append(row); }
        const target = grid.querySelector('[aria-selected="true"]') || grid.querySelector('[aria-current="date"]') || grid.querySelector('button:not(.adjacent)');
        if (target) target.tabIndex = 0;
        popup.append(grid);
        const footer = node('div', '', 'date-picker-footer');
        footer.append(button('清空', '清空日期', () => commit(''), 'date-picker-clear'), button(mode() === 'year' ? '今年' : mode() === 'month' ? '本月' : '今天', '选择当前' + (mode() === 'year' ? '年份' : mode() === 'month' ? '月份' : '日期'), () => commit(format(now.year, now.month, now.day, mode())), 'date-picker-today'));
        popup.append(footer); position();
        if (focusGrid) target?.focus({ preventScroll: true }); focusGrid = true;
      }

      document.body.append(popup); if (popup.showPopover) popup.showPopover(); render();
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
      document.addEventListener('pointerdown', (event) => { if (!popup.contains(event.target) && !trigger.contains(event.target) && event.target !== input) close(); }, { capture: true, signal });
      document.addEventListener('focusin', (event) => { if (!popup.contains(event.target) && event.target !== input && event.target !== trigger) close(); }, { signal });
      window.addEventListener('resize', position, { signal });
      // 控件被浏览器滚动到视口时也会触发 scroll；重新定位而非误关闭刚打开的日历。
      window.addEventListener('scroll', (event) => { if (!popup.contains(event.target)) position(); }, { capture: true, signal });
      window.addEventListener('pagehide', () => close(), { signal });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
        const current = event.target.closest?.('.date-picker-cell'); if (!current) return;
        const cells = [...popup.querySelectorAll('.date-picker-cell')]; const index = cells.indexOf(current); const columns = view === 'days' ? 7 : 3;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
        if (step) { event.preventDefault(); const next = cells[Math.max(0, Math.min(cells.length - 1, index + step))]; current.tabIndex = -1; next.tabIndex = 0; next.focus({ preventScroll: true }); }
      }, { signal });
    }

    trigger.addEventListener('click', () => { if (active?.input === input) close(true); else open(); });
    // 点击文本框仍保留输入焦点，用户可直接键入；图标或向下键再进入日期网格。
    input.addEventListener('click', () => open(false));
    input.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' || event.key === 'Enter') { if (mode() !== 'legacy') { event.preventDefault(); open(); } } });
    // 调整精度时只更新格式提示和可用状态，输入值由工作台按既有规则处理。
    function refresh() {
      if (active?.input === input) close(); trigger.hidden = mode() === 'legacy'; input.dataset.datePrecision = mode();
      input.placeholder = mode() === 'legacy' ? '保留原有文本或输入说明' : mode() === 'year' ? 'YYYY' : mode() === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
      input.removeAttribute('aria-invalid'); input.setCustomValidity(''); status.hidden = true; status.textContent = '';
    }
    refresh(); return { refresh };
  }

  globalThis.LocalApplyDatePicker = Object.freeze({ parse, format, monthDays, attach });
})();
