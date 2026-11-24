function installWorkspaceFolding(doc, win) {
  if (!doc || !win) {
    return function dispose() {};
  }

  const STORAGE_KEY = 'dsh-folding-windows:workspaces-collapsed:v1';
  const HIDDEN_ATTR = 'data-dsh-folding-workspaces-hidden';
  const STYLE_ATTR = 'data-dsh-folding-workspaces-style';
  const TOGGLE_SELECTOR = 'button[data-dsh-folding-control][data-dsh-folding-section="workspaces"]';
  const NEW_SESSION_LABELS = ['新建会话', 'New session'];
  const SEARCH_LABELS = ['搜索会话', 'Search sessions'];
  const SESSION_TREE_LABELS = ['会话', 'Sessions'];

  const records = new Map();
  let collapsed = false;
  let disposed = false;
  let scanScheduled = false;
  let idCounter = 0;

  function isDiv(el) {
    return !!el && el.nodeType === 1 && el.tagName === 'DIV';
  }

  function isButton(el) {
    return !!el && el.nodeType === 1 && el.tagName === 'BUTTON';
  }

  function setAttrIfChanged(el, name, value) {
    if (el && el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  function removeAttrIfChanged(el, name) {
    if (el && el.hasAttribute(name)) {
      el.removeAttribute(name);
    }
  }

  function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) {
      el.textContent = text;
    }
  }

  function getLocalStorage() {
    try {
      return win.localStorage;
    } catch (e) {
      return null;
    }
  }

  function readStoredCollapsed() {
    const ls = getLocalStorage();
    if (!ls) return false;
    try {
      return ls.getItem(STORAGE_KEY) === 'true';
    } catch (e) {
      return false;
    }
  }

  function writeStoredCollapsed(value) {
    const ls = getLocalStorage();
    if (!ls) return;
    try {
      ls.setItem(STORAGE_KEY, value ? 'true' : 'false');
    } catch (e) {}
  }

  function ensureStyle() {
    let style = doc.querySelector('style[' + STYLE_ATTR + ']');
    if (!style) {
      style = doc.createElement('style');
      style.setAttribute(STYLE_ATTR, '');
      (doc.head || doc.documentElement).appendChild(style);
    }
    style.textContent =
      'button[data-dsh-folding-control][data-dsh-folding-section="workspaces"]{flex:none;}' +
      'button[data-dsh-folding-control][data-dsh-folding-section="workspaces"][data-dsh-folding-in-header="false"][aria-expanded="false"]{margin-bottom:auto;}' +
      'button[data-dsh-folding-control][data-dsh-folding-section="workspaces"][data-dsh-folding-in-header="true"]{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;margin:0 4px 0 0;border:0;background:transparent;border-radius:6px;cursor:pointer;color:inherit;font-size:12px;line-height:1;}' +
      'button[data-dsh-folding-control][data-dsh-folding-section="workspaces"][data-dsh-folding-in-header="true"] [data-dsh-folding-role="label"]{display:none;}' +
      '[data-dsh-folding-header-clickable="true"]{cursor:pointer;}' +
      '[data-dsh-folding-workspaces-hidden="true"]{display:none!important;}';
    return style;
  }

  function isSearchButton(el) {
    if (!isButton(el)) return false;
    return SEARCH_LABELS.indexOf(el.getAttribute('aria-label')) !== -1;
  }

  function findSearchButton(scope) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return null;
    const buttons = scope.querySelectorAll('button[aria-label]');
    for (let i = 0; i < buttons.length; i++) {
      if (isSearchButton(buttons[i])) return buttons[i];
    }
    return null;
  }

  function detectLanguage(searchButton) {
    return searchButton && searchButton.getAttribute('aria-label') === '搜索会话' ? 'zh' : 'en';
  }

  function findSessionTree(scope) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return null;
    const trees = scope.querySelectorAll('[role="tree"]');
    let fallback = null;
    for (let i = 0; i < trees.length; i++) {
      const label = trees[i].getAttribute('aria-label');
      if (label === SESSION_TREE_LABELS[0] || label === SESSION_TREE_LABELS[1]) return trees[i];
      if (!fallback) fallback = trees[i];
    }
    return fallback;
  }

  // The "工作区" title row (label + search + actions) is the topmost ancestor of
  // the search button that does not also wrap the session tree. Injecting the
  // fold button there reuses the existing workspace menu instead of inventing a
  // second "工作区" row.
  function findHeader(searchButton, tree, seat) {
    let node = searchButton;
    let header = null;
    while (node && node !== seat) {
      const parent = node.parentElement;
      if (!parent || parent === seat) break;
      if (parent.contains(tree)) break;
      header = parent;
      node = parent;
    }
    return header;
  }

  function findListTarget(tree, header, seat) {
    const parent = tree.parentElement;
    if (parent && parent !== seat && !parent.contains(header)) return parent;
    return tree;
  }

  // Locate the visible "工作区 / Workspaces" caption inside the header. The fold
  // button belongs after this caption, never before it.
  function findHeaderLabel(header, language) {
    if (!header) return null;
    const preferred = header.querySelector('.workspace-label');
    if (preferred && header.contains(preferred)) return preferred;
    const children = header.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || child.tagName === 'BUTTON' || child.tagName === 'INPUT') continue;
      if (typeof child.querySelector === 'function' && child.querySelector('button, input')) continue;
      const raw = child.textContent || '';
      if (!raw.trim()) continue;
      if (language === 'zh' ? raw.indexOf('工作区') !== -1 : /workspace/i.test(raw)) return child;
    }
    return null;
  }

  function findBrowser(seat) {
    const searchButton = findSearchButton(seat);
    if (!searchButton) return null;
    // DSH renders the browser inside slot wrappers whose depth is not part of
    // its public contract, so the session tree — not a child layout — proves
    // this seat owns the workspace area.
    const tree = findSessionTree(seat);
    if (!tree) return null;
    const header = findHeader(searchButton, tree, seat);
    const listTarget = header ? findListTarget(tree, header, seat) : null;
    return { searchButton: searchButton, tree: tree, header: header, listTarget: listTarget };
  }

  // DSH 0.2.2 moved the New Session control out of the panel nav's parent, so
  // the sidebar is discovered from the panel nav itself. Each entry carries the
  // element that directly holds the nav and the workspace region, plus the
  // resolved sidebar column used for the collapsed-rail check.
  function findRoots() {
    const roots = [];
    foldingCompatEachPanelNav(doc, function visit(nav) {
      const root = foldingCompatResolveHost(nav);
      const column = foldingCompatResolveColumn(nav);
      if (!isDiv(root) || !column) return;
      if (roots.indexOf(root) === -1) roots.push({ host: root, column: column, nav: nav });
    });
    return roots;
  }

  function generateUniqueId() {
    let id;
    do {
      idCounter += 1;
      id = 'dsh-folding-workspaces-seat-' + idCounter;
    } while (doc.getElementById(id));
    return id;
  }

  function ensureSeatId(record) {
    const target = record.hideTarget || record.seat;
    const existing = target.getAttribute('id');
    if (existing) return existing;

    if (record.generatedId && !doc.getElementById(record.generatedId)) {
      target.setAttribute('id', record.generatedId);
      return record.generatedId;
    }

    const id = generateUniqueId();
    record.generatedId = id;
    target.setAttribute('id', id);
    return id;
  }

  function resolveHideTarget(seat, header, listTarget) {
    return header && listTarget ? listTarget : seat;
  }

  function applyBrowserInfo(record, browserInfo) {
    record.searchButton = browserInfo.searchButton;
    record.language = detectLanguage(browserInfo.searchButton);
    record.tree = browserInfo.tree;
    record.header = browserInfo.header;
    record.headerLabel = null;
    record.listTarget = browserInfo.listTarget;
    const nextTarget = resolveHideTarget(record.seat, record.header, record.listTarget);
    if (record.hideTarget !== nextTarget) {
      if (record.hideTarget) restoreTargetAttributes(record);
      record.hideTarget = nextTarget;
      record.oldHidden = nextTarget ? nextTarget.getAttribute(HIDDEN_ATTR) : null;
      record.oldId = nextTarget ? nextTarget.getAttribute('id') : null;
    }
    bindHeaderClick(record);
  }

  function createRecord(root, appFrame, nav, seat, browserInfo) {
    const record = {
      root: root,
      appFrame: appFrame,
      nav: nav,
      seat: seat,
      searchButton: null,
      tree: null,
      header: null,
      headerLabel: null,
      listTarget: null,
      hideTarget: null,
      language: 'zh',
      toggle: null,
      oldId: null,
      oldHidden: null,
      generatedId: null,
      handleClick: null,
      headerBound: null,
      headerHandleClick: null
    };

    applyBrowserInfo(record, browserInfo);

    record.handleClick = function (event) {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      applyCollapsed(!collapsed, { persist: true });
    };

    return record;
  }

  // Let a click anywhere on the workspace header row (except its inner buttons and
  // inputs) toggle the section, matching how the fold icon behaves.
  function bindHeaderClick(record) {
    const header = record.header;
    if (record.headerBound && record.headerBound !== header) detachHeaderClick(record);
    if (!header) {
      if (record.headerBound) detachHeaderClick(record);
      return;
    }
    if (record.headerBound === header) return;
    record.headerBound = header;
    setAttrIfChanged(header, 'data-dsh-folding-header-clickable', 'true');
    record.headerHandleClick = function (event) {
      const target = event && event.target;
      if (target && typeof target.closest === 'function') {
        if (target.closest('button, input, textarea, select, a, [role="button"], [role="treeitem"], [contenteditable="true"]')) {
          return;
        }
      }
      if (typeof record.handleClick === 'function') record.handleClick(event);
    };
    header.addEventListener('click', record.headerHandleClick);
  }

  function detachHeaderClick(record) {
    const header = record.headerBound;
    if (header && record.headerHandleClick) {
      header.removeEventListener('click', record.headerHandleClick);
    }
    if (header) removeAttrIfChanged(header, 'data-dsh-folding-header-clickable');
    record.headerBound = null;
    record.headerHandleClick = null;
  }

  function detachToggle(record) {
    const toggle = record.toggle;
    if (!toggle) return;
    if (record.handleClick) {
      toggle.removeEventListener('click', record.handleClick);
    }
    if (toggle.parentNode) {
      toggle.parentNode.removeChild(toggle);
    }
    record.toggle = null;
  }

  function createToggle(record) {
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    setAttrIfChanged(toggle, 'data-dsh-folding-control', '');
    setAttrIfChanged(toggle, 'data-dsh-folding-section', 'workspaces');

    const label = doc.createElement('span');
    setAttrIfChanged(label, 'data-dsh-folding-role', 'label');

    const arrow = doc.createElement('span');
    setAttrIfChanged(arrow, 'data-dsh-folding-role', 'arrow');
    setAttrIfChanged(arrow, 'aria-hidden', 'true');

    toggle.appendChild(label);
    toggle.appendChild(arrow);
    toggle.addEventListener('click', record.handleClick);
    record.toggle = toggle;
  }

  function togglePlacement(record) {
    if (record.header && record.header.isConnected) {
      let label = record.headerLabel;
      if (!label || !label.isConnected || label.parentNode !== record.header) {
        label = findHeaderLabel(record.header, record.language);
        record.headerLabel = label;
      }
      if (label) {
        let before = label.nextSibling;
        if (before === record.toggle) before = record.toggle.nextSibling;
        return { parent: record.header, before: before };
      }
      return { parent: record.header, before: null };
    }
    const placement = foldingCompatResolveControlPlacement(record.nav);
    return placement || { parent: record.root, before: record.seat };
  }

  function ensureToggle(record) {
    let toggle = record.toggle;
    if (toggle && (!toggle.isConnected || toggle.getAttribute('data-dsh-folding-section') !== 'workspaces')) {
      detachToggle(record);
      toggle = null;
    }
    if (!toggle) {
      createToggle(record);
      toggle = record.toggle;
    }
    const placement = togglePlacement(record);
    if (!foldingCompatHasControlPlacement(toggle, placement)) {
      placement.parent.insertBefore(toggle, placement.before);
    }
  }

  function applyRecord(record) {
    const seat = record.seat;
    const target = record.hideTarget || seat;
    const toggle = record.toggle;
    if (!seat.isConnected || !toggle || !toggle.isConnected) return;

    const placement = togglePlacement(record);
    if (!foldingCompatHasControlPlacement(toggle, placement)) {
      placement.parent.insertBefore(toggle, placement.before);
    }

    const inHeader = !!record.header;
    setAttrIfChanged(toggle, 'data-dsh-folding-in-header', inHeader ? 'true' : 'false');

    const targetId = ensureSeatId(record);
    setAttrIfChanged(toggle, 'aria-controls', targetId);
    setAttrIfChanged(toggle, 'aria-expanded', collapsed ? 'false' : 'true');
    setAttrIfChanged(
      toggle,
      'title',
      record.language === 'zh'
        ? (collapsed ? '展开工作区' : '收起工作区')
        : (collapsed ? 'Expand workspaces' : 'Collapse workspaces')
    );

    const columnCollapsed = foldingCompatIsColumnCollapsed(record.appFrame);
    setAttrIfChanged(toggle, 'data-dsh-folding-column-collapsed', columnCollapsed ? 'true' : 'false');

    const label = toggle.querySelector('[data-dsh-folding-role="label"]');
    setTextIfChanged(label, inHeader ? '' : (record.language === 'zh' ? '工作区' : 'Workspaces'));

    const arrow = toggle.querySelector('[data-dsh-folding-role="arrow"]');
    setTextIfChanged(arrow, collapsed ? '▸' : '▾');

    if (collapsed) {
      setAttrIfChanged(target, HIDDEN_ATTR, 'true');
    } else {
      removeAttrIfChanged(target, HIDDEN_ATTR);
    }
  }

  function applyAll() {
    records.forEach(function (record) {
      applyRecord(record);
    });
  }

  function moveFocusOutOfSeats() {
    const active = doc.activeElement;
    if (!active || active === doc.body) return;

    records.forEach(function (record) {
      if (record.seat.contains(active)) {
        const toggle = record.toggle;
        if (toggle && typeof toggle.focus === 'function') {
          try {
            toggle.focus({ preventScroll: true });
          } catch (e) {
            toggle.focus();
          }
        }
      }
    });
  }

  function applyCollapsed(next, options) {
    if (disposed) return;
    const opts = options || {};
    const changed = collapsed !== next;
    collapsed = next;

    if (changed && opts.persist) {
      writeStoredCollapsed(collapsed);
    }
    if (changed && collapsed) {
      moveFocusOutOfSeats();
    }
    applyAll();
  }

  function restoreTargetAttributes(record) {
    const target = record.hideTarget;
    if (!target) return;
    if (record.oldHidden === null) removeAttrIfChanged(target, HIDDEN_ATTR);
    else setAttrIfChanged(target, HIDDEN_ATTR, record.oldHidden);
    if (record.generatedId && target.getAttribute('id') === record.generatedId) {
      if (record.oldId === null) target.removeAttribute('id');
      else target.setAttribute('id', record.oldId);
    }
  }

  function removeRecord(record) {
    detachHeaderClick(record);
    detachToggle(record);
    restoreTargetAttributes(record);
    records.delete(record.seat);
  }

  function scan() {
    if (disposed) return;

    const seen = new Set();
    const roots = findRoots();

    for (let r = 0; r < roots.length; r++) {
      const root = roots[r].host;
      const appFrame = roots[r].column;
      const children = Array.from(root.children);

      for (let i = 0; i < children.length; i++) {
        const seat = children[i];
        if (!isDiv(seat)) continue;

        const browserInfo = findBrowser(seat);
        if (!browserInfo) continue;

        let record = records.get(seat);
        if (!record) {
          record = createRecord(root, appFrame, roots[r].nav, seat, browserInfo);
          records.set(seat, record);
        } else {
          record.root = root;
          record.appFrame = appFrame;
          record.nav = roots[r].nav;
          applyBrowserInfo(record, browserInfo);
        }

        seen.add(seat);
        ensureToggle(record);
        if (collapsed && seat.contains(doc.activeElement)) moveFocusOutOfSeats();
        applyRecord(record);
      }
    }

    Array.from(records.values()).forEach(function (record) {
      if (!seen.has(record.seat)) {
        removeRecord(record);
      }
    });
  }

  function scheduleScan() {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    Promise.resolve().then(function () {
      scanScheduled = false;
      if (!disposed) scan();
    });
  }

  function mutationIsOwnOnly(mutation) {
    if (!mutation || mutation.type !== 'childList') return false;

    const nodes = [];
    Array.from(mutation.addedNodes).forEach(function (node) { nodes.push(node); });
    Array.from(mutation.removedNodes).forEach(function (node) { nodes.push(node); });
    if (!nodes.length) return false;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 1 && typeof node.matches === 'function' && node.matches(TOGGLE_SELECTOR)) {
        if (mutation.removedNodes.length) return false;
      }
    }

    const onlyOwnToggles = nodes.every(function (node) {
      return node.nodeType === 1 && typeof node.matches === 'function' && node.matches(TOGGLE_SELECTOR);
    });
    if (onlyOwnToggles) return true;

    let ownTextChange = false;
    records.forEach(function (record) {
      const toggle = record.toggle;
      if (!toggle) return;
      if (toggle === mutation.target || toggle.contains(mutation.target)) {
        const allInsideToggle = nodes.every(function (node) {
          return toggle === node || toggle.contains(node);
        });
        if (allInsideToggle) ownTextChange = true;
      }
    });

    return ownTextChange;
  }

  function onMutations(mutations) {
    if (disposed) return;
    for (let i = 0; i < mutations.length; i++) {
      if (!mutationIsOwnOnly(mutations[i])) {
        scheduleScan();
        return;
      }
    }
  }

  function onStorage(event) {
    if (disposed || !event) return;
    if (event.key !== null && event.key !== STORAGE_KEY) return;

    const ls = getLocalStorage();
    if (event.storageArea && (!ls || event.storageArea !== ls)) return;

    applyCollapsed(readStoredCollapsed(), { persist: false });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;

    if (observer) observer.disconnect();
    if (typeof win.removeEventListener === 'function') {
      win.removeEventListener('storage', onStorage);
    }

    Array.from(records.values()).forEach(function (record) {
      removeRecord(record);
    });
    records.clear();

    if (styleElement && styleElement.parentNode) {
      styleElement.parentNode.removeChild(styleElement);
    }
  }

  collapsed = readStoredCollapsed();

  const styleElement = ensureStyle();

  const ObserverCtor = win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
  const observer = ObserverCtor ? new ObserverCtor(onMutations) : null;

  if (observer) {
    observer.observe(doc.documentElement || doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-sidebar-collapsed']
    });
  }

  if (typeof win.addEventListener === 'function') {
    win.addEventListener('storage', onStorage);
  }

  scan();

  return dispose;
}
