// 可输入的服务商选择器：展开完整列表，当前项高亮并滚动定位，不使用原生 datalist 的值过滤。
'use strict';

// 创建独立选择器；onSelect 接收服务商 ID 或用户输入的地址，持久化仍由设置页负责。
function createProviderPicker(onSelect) {
  const input = document.getElementById('provider');
  const toggle = document.getElementById('providerToggle');
  const list = document.getElementById('providerList');
  const wrapper = document.getElementById('providerPicker');
  let providers = [];
  let selectedId = '';
  let selectedName = '';
  let active = -1;

  // 同步键盘活动项；当前已保存项由 aria-selected 单独表示，导航本身不改配置。
  function activate(index, center = false) {
    active = index;
    [...list.children].forEach((item, i) => item.classList.toggle('active', i === active));
    const item = list.children[active];
    if (!item) { input.removeAttribute('aria-activedescendant'); return; }
    input.setAttribute('aria-activedescendant', item.id);
    if (center) list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
    else if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
  }

  // 每次展开都显示全部条目，并从已保存的服务商开始定位。
  function open() {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-expanded', 'true');
    activate(Math.max(0, providers.findIndex((provider) => provider.providerId === selectedId)), true);
  }

  // 关闭弹层并清除活动项，不丢失已选择的名称。
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  // 提交选择或手输地址；提前标记输入可避免回车后失焦重复提交。
  function select(value) {
    selectedName = input.value;
    close();
    onSelect(value);
  }

  // 重新渲染内置和自定义服务商；只用 textContent 展示用户提供的地址。
  function update(entries, currentId) {
    providers = entries;
    selectedId = currentId;
    selectedName = entries.find((provider) => provider.providerId === currentId)?.name || '';
    input.value = selectedName;
    list.replaceChildren();
    entries.forEach((provider, index) => {
      const item = document.createElement('div');
      item.id = 'provider-option-' + index;
      item.className = 'provider-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(provider.providerId === currentId));
      item.dataset.providerId = provider.providerId;
      const title = document.createElement('strong');
      title.textContent = provider.name;
      const address = document.createElement('small');
      address.textContent = provider.baseUrl || '填写自定义接口地址';
      item.append(title, address);
      if (provider.providerId === currentId) {
        const marker = document.createElement('span'); marker.className = 'provider-current'; marker.textContent = '✓ 当前';
        item.append(marker);
      }
      // 鼠标选中直接交回 ID，不让输入失焦提前创建错误服务商。
      item.addEventListener('click', () => select(provider.providerId));
      list.append(item);
    });
    close();
  }

  // 点击输入或箭头均展开完整列表，保留输入内容以便继续编辑地址。
  input.addEventListener('click', open);
  toggle.addEventListener('pointerdown', (event) => event.preventDefault());
  toggle.addEventListener('click', () => { input.focus(); if (list.hidden) open(); else close(); });
  list.addEventListener('pointerdown', (event) => event.preventDefault());
  // 只有修改过的文本在失焦时提交，普通浏览候选项不会触发配置写入。
  input.addEventListener('blur', () => { close(); if (input.value !== selectedName) select(input.value); });
  document.addEventListener('pointerdown', (event) => { if (!wrapper.contains(event.target)) close(); });
  // 方向键浏览、回车确认；手输值优先提交，Escape 则撤销未提交文本。
  input.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.ctrlKey && !event.metaKey) {
      if (list.hidden && ['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (list.hidden) open();
      else activate(event.key === 'Home' ? 0 : event.key === 'End' ? providers.length - 1
        : Math.max(0, Math.min(providers.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      select(!list.hidden && input.value === selectedName && providers[active] ? providers[active].providerId : input.value);
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault(); input.value = selectedName; close();
    } else if (event.key === 'Tab') close();
  });
  return { update };
}
