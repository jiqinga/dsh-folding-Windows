window.__ModuleLoader__.load({ id: "@jiqinga/dsh-folding-windows", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';

// Layout compatibility layer.
//
// The plugin originally targeted the DSH 0.2.0-rc.2 / 0.2.1-rc.2 sidebar, where
// the global-panel <nav> and the "New session" control were direct siblings
// inside the sidebar column. DSH 0.2.2 restructured that column:
//
//   div.root                                   <- sidebar column
//   +- div.logoRow
//   +- div.newSessionRow > button[新建会话]      <- moved out of the nav's parent
//   +- div.scrollRegion                        <- new wrapper
//   |   +- div.scrollArea[data-sidebar-scrollport]
//   |       +- nav.panelList[全局面板]
//   |       +- div.regionArea                  <- workspace seat
//   +- div.footArea
//
// and the collapsed state moved from a data-sidebar-collapsed attribute to a
// CSS-modules class on the column. Everything below resolves those two shapes
// from the panel <nav> alone, which is the only element with a stable public
// label in both versions.

const FOLDING_COMPAT_NEW_SESSION_LABELS = ['新建会话', 'New session'];
const FOLDING_COMPAT_PANEL_NAV_LABELS = ['全局面板', 'Global panels'];
const FOLDING_COMPAT_NAV_SELECTOR = 'nav[aria-label="全局面板"],nav[aria-label="Global panels"]';
const FOLDING_COMPAT_MAX_WALK = 8;

function foldingCompatIsElement(node) {
  return !!node && node.nodeType === 1;
}

function foldingCompatHasLabel(element, labels) {
  return foldingCompatIsElement(element) && labels.indexOf(element.getAttribute('aria-label')) !== -1;
}

/** Whether scope owns a "New session" control anywhere inside it. */
function foldingCompatOwnsNewSession(scope) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return false;
  const buttons = scope.querySelectorAll('button[aria-label]');
  for (let i = 0; i < buttons.length; i++) {
    if (foldingCompatHasLabel(buttons[i], FOLDING_COMPAT_NEW_SESSION_LABELS)) return true;
  }
  return false;
}

/** Visit every global-panel nav in the document. */
function foldingCompatEachPanelNav(doc, visit) {
  const navs = doc.querySelectorAll(FOLDING_COMPAT_NAV_SELECTOR);
  for (let i = 0; i < navs.length; i++) {
    if (foldingCompatHasLabel(navs[i], FOLDING_COMPAT_PANEL_NAV_LABELS)) visit(navs[i]);
  }
}

/**
 * The sidebar column: the closest ancestor of the nav that also owns the New
 * Session control. Depth 0 on 0.2.0/0.2.1, depth 2 on 0.2.2.
 * @param nav - the global-panel nav element.
 * @returns the column element, or null when the layout is unrecognised.
 */
function foldingCompatResolveColumn(nav) {
  let node = nav.parentElement;
  for (let depth = 0; node && depth < FOLDING_COMPAT_MAX_WALK; depth++) {
    if (foldingCompatOwnsNewSession(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * The element that directly holds both the panel nav and the workspace region.
 * Workspace seats are discovered here; control placement is resolved separately.
 * @param nav - the global-panel nav element.
 * @returns the host element, or null.
 */
function foldingCompatResolveHost(nav) {
  const host = nav.parentElement;
  return foldingCompatIsElement(host) ? host : null;
}

/**
 * Resolve the persistent sidebar slot for a folding control.
 *
 * Legacy layouts keep the nav directly in the sidebar column. Modern layouts
 * put it inside a scrollport; place controls before that scrollport instead.
 * @param nav - the global-panel nav element.
 * @returns an insertion parent and anchor, or null.
 */
function foldingCompatResolveControlPlacement(nav) {
  const host = foldingCompatResolveHost(nav);
  const column = foldingCompatResolveColumn(nav);
  if (!host || !column) return null;
  if (host === column) return { parent: host, before: nav };

  let child = host;
  while (child.parentElement && child.parentElement !== column) {
    child = child.parentElement;
  }
  if (child.parentElement === column) return { parent: column, before: child };
  return { parent: host, before: nav };
}

/** Return true when an element is in the placement slot before its anchor. */
function foldingCompatHasControlPlacement(element, placement) {
  if (!placement || element.parentNode !== placement.parent) return false;
  if (!placement.before) return true;
  let sibling = element.nextSibling;
  while (sibling) {
    if (sibling === placement.before) return true;
    sibling = sibling.nextSibling;
  }
  return false;
}

/**
 * Whether the whole sidebar column is collapsed down to its rail.
 * Reads the 0.2.1 attribute and the 0.2.2 CSS-modules class.
 * @param column - the element returned by foldingCompatResolveColumn.
 * @returns true when the column is collapsed.
 */
function foldingCompatIsColumnCollapsed(column) {
  if (!foldingCompatIsElement(column)) return false;
  if (column.getAttribute('data-sidebar-collapsed') === 'true') return true;
  const frame = column.parentElement;
  if (frame && frame.getAttribute('data-sidebar-collapsed') === 'true') return true;
  const className = typeof column.className === 'string' ? column.className : '';
  return /(?:^|\s)[^\s]*collapsed[^\s]*(?:\s|$)/.test(className);
}

function createProjectPinController(service, win) {
  let disposed = false;
  let busy = false;
  let error = null;
  let pinnedIds = [];
  let baseOrder = [];
  const listeners = new Set();
  let sourceUnsubscribe = null;
  let failureLatch = false;
  let sourceChangedDuringBusy = false;
  let pendingStorageUpdate = null;
  let lastSnapshotPhase = service.list.getSnapshot().phase;
  let internalOrders = null;
  let storageRevision = 0;

  function validIds(value) {
    return Array.isArray(value) ? Array.from(new Set(value.filter(id => typeof id === 'string' && id.length > 0))) : [];
  }

  function loadPersistedState() {
    try {
      const stored = win.localStorage.getItem('dsh-folding-windows:project-pins:v1');
      if (!stored) return { pinnedIds: [], baseOrder: [] };
      const parsed = JSON.parse(stored);
      const pinnedIds = validIds(parsed?.pinnedIds);
      const baseOrder = validIds(parsed?.baseOrder);
      return { pinnedIds, baseOrder };
    } catch (e) {
      return { pinnedIds: [], baseOrder: [] };
    }
  }

  function savePersistedState() {
    if (disposed || pendingStorageUpdate) return;
    try {
      const data = { pinnedIds: [...pinnedIds], baseOrder: [...baseOrder] };
      const serialized = JSON.stringify(data);
      const existing = win.localStorage.getItem('dsh-folding-windows:project-pins:v1');
      if (existing === serialized) return;
      win.localStorage.setItem('dsh-folding-windows:project-pins:v1', serialized);
    } catch (e) {
      // Ignore storage errors
    }
  }

  function syncBaseOrderWithSource(snapshot = service.list.getSnapshot()) {
    if (snapshot.phase !== 'ready') return;
    const currentIds = snapshot.items.map(item => item.workspaceId);
    const currentIdSet = new Set(currentIds);
    const currentPinnedSet = new Set(pinnedIds);
    const filteredOldBase = baseOrder.filter(id => currentIdSet.has(id));
    const newIds = currentIds.filter(id => !baseOrder.includes(id));
    const skeleton = [...filteredOldBase, ...newIds];
    const unpinnedSequence = currentIds.filter(id => !currentPinnedSet.has(id));
    let unpinnedIdx = 0;
    const newBase = skeleton.map(id => currentPinnedSet.has(id) ? id : unpinnedSequence[unpinnedIdx++]);
    const newPinned = pinnedIds.filter(id => currentIdSet.has(id));
    const baseChanged = JSON.stringify(newBase) !== JSON.stringify(baseOrder);
    const pinnedChanged = JSON.stringify(newPinned) !== JSON.stringify(pinnedIds);
    if (baseChanged || pinnedChanged) {
      baseOrder = newBase;
      pinnedIds = newPinned;
      savePersistedState();
    }
  }

  function computeDesiredOrder(pinnedSet, base) {
    return [...Array.from(pinnedSet), ...base.filter(id => !pinnedSet.has(id))];
  }

  async function reconcileOrder(desired) {
    try {
      const snapshot = service.list.getSnapshot();
      if (snapshot.phase !== 'ready' || disposed) return false;
      const currentOrder = snapshot.items.map(item => item.workspaceId);
      if (currentOrder.length === desired.length && currentOrder.every((id, i) => id === desired[i])) return true;
      const maxMoves = snapshot.items.length;
      let moves = 0;
      while (moves < maxMoves) {
        if (disposed) return false;
        const snap = service.list.getSnapshot();
        if (snap.phase !== 'ready') return false;
        const current = snap.items.map(item => item.workspaceId);
        if (current.length === desired.length && current.every((id, i) => id === desired[i])) return true;
        let firstMismatch = -1;
        const minLen = Math.min(current.length, desired.length);
        for (let i = 0; i < minLen; i++) {
          if (current[i] !== desired[i]) {
            firstMismatch = i;
            break;
          }
        }
        if (firstMismatch === -1) return current.length === desired.length;
        const idToMove = desired[firstMismatch];
        const currentIndex = current.indexOf(idToMove);
        if (currentIndex === -1) return false;
        const beforeId = current[firstMismatch];
        const nextOrder = current.filter(id => id !== idToMove);
        nextOrder.splice(firstMismatch, 0, idToMove);
        internalOrders = new Set([JSON.stringify(current), JSON.stringify(nextOrder)]);
        try {
          await service.insertBefore(idToMove, beforeId);
          moves++;
        } catch (e) {
          throw e;
        }
        if (disposed) return false;
        if (sourceChangedDuringBusy || pendingStorageUpdate) return true;
      }
      const finalSnap = service.list.getSnapshot();
      const finalOrder = finalSnap.items.map(item => item.workspaceId);
      return finalOrder.length === desired.length && finalOrder.every((id, i) => id === desired[i]);
    } finally {
      internalOrders = null;
    }
  }

  function applyStoredState(update) {
    pinnedIds = [...update.newPinned];
    baseOrder = [...update.newBase];
    const snapshot = service.list.getSnapshot();
    if (snapshot.phase === 'ready') {
      const ids = snapshot.items.map(item => item.workspaceId);
      const current = new Set(ids);
      pinnedIds = pinnedIds.filter(id => current.has(id));
      baseOrder = [...baseOrder.filter(id => current.has(id)), ...ids.filter(id => !baseOrder.includes(id))];
    }
    failureLatch = false;
    error = null;
    savePersistedState();
  }

  async function runReconciliation(desired, rollback = null) {
    if (disposed || busy) return false;
    busy = true;
    error = null;
    sourceChangedDuringBusy = false;
    notifyListener();
    let success = true;
    try {
      try {
        if (!await reconcileOrder(desired)) throw new Error('Order convergence failed');
      } catch (e) {
        success = false;
        if (disposed) return false;
        error = 'reorder_failed';
        failureLatch = true;
        if (rollback && storageRevision === rollback.revision && !pendingStorageUpdate) {
          pinnedIds = rollback.pinnedIds;
          baseOrder = rollback.baseOrder;
          savePersistedState();
        }
      }
      if (disposed) return false;
      // At most one coalesced follow-up in this transaction. Own optimistic
      // snapshots are excluded in handleSourceUpdate, including failure rollback.
      if (pendingStorageUpdate || (sourceChangedDuringBusy && !failureLatch)) {
        if (pendingStorageUpdate) {
          const pending = pendingStorageUpdate;
          pendingStorageUpdate = null;
          applyStoredState(pending);
        }
        sourceChangedDuringBusy = false;
        try {
          if (!await reconcileOrder(computeDesiredOrder(new Set(pinnedIds), baseOrder))) {
            throw new Error('Order convergence failed');
          }
        } catch (e) {
          if (!disposed) {
            error = 'reorder_failed';
            failureLatch = true;
          }
          success = false;
        }
      }
      return success && !disposed;
    } finally {
      busy = false;
      notifyListener();
      if (!disposed && (pendingStorageUpdate || (sourceChangedDuringBusy && !failureLatch))) {
        queueMicrotask(() => {
          if (disposed || busy) return;
          if (pendingStorageUpdate) {
            const pending = pendingStorageUpdate;
            pendingStorageUpdate = null;
            applyStoredState(pending);
          }
          sourceChangedDuringBusy = false;
          runReconciliation(computeDesiredOrder(new Set(pinnedIds), baseOrder));
        });
      }
    }
  }

  function notifyListener() {
    if (disposed) return;
    for (const listener of [...listeners]) listener(getState());
  }

  function getState() {
    const snapshot = service.list.getSnapshot();
    return {
      items: snapshot.items,
      phase: snapshot.phase,
      pinnedIds: [...pinnedIds],
      busy: busy,
      error: error
    };
  }

  function subscribe(listener) {
    if (disposed) return () => {};
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  async function toggle(id) {
    if (disposed) return false;
    const snapshot = service.list.getSnapshot();
    if (snapshot.phase !== 'ready') return false;
    if (typeof id !== 'string' || id.trim() === '' || !snapshot.items.some(item => item.workspaceId === id)) return false;
    if (busy) return false;
    failureLatch = false;
    syncBaseOrderWithSource();
    const oldPinned = [...pinnedIds];
    const oldBase = [...baseOrder];
    const revision = storageRevision;
    const newPinned = [...oldPinned];
    const idx = newPinned.indexOf(id);
    if (idx === -1) newPinned.unshift(id);
    else newPinned.splice(idx, 1);
    const currentIdSet = new Set(snapshot.items.map(item => item.workspaceId));
    const validPinned = newPinned.filter(pid => currentIdSet.has(pid));
    const validPinnedSet = new Set(validPinned);
    pinnedIds = Array.from(validPinnedSet);
    const desired = computeDesiredOrder(validPinnedSet, baseOrder);
    savePersistedState();
    return runReconciliation(desired, { pinnedIds: oldPinned, baseOrder: oldBase, revision });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (sourceUnsubscribe) {
      sourceUnsubscribe();
      sourceUnsubscribe = null;
    }
    if (typeof win.removeEventListener === 'function') {
      win.removeEventListener('storage', handleStorageEvent);
    }
    listeners.clear();
    busy = false;
    error = null;
    failureLatch = false;
    sourceChangedDuringBusy = false;
    pendingStorageUpdate = null;
  }

  function handleSourceUpdate() {
    if (disposed) return;
    const snapshot = service.list.getSnapshot();
    const phaseChanged = snapshot.phase !== lastSnapshotPhase;
    if (phaseChanged) lastSnapshotPhase = snapshot.phase;
    // A native call we are awaiting republishes the order we asked for. Anything
    // else — including an edit landing while that call is in flight — is external
    // and must be adopted as the ordinary order instead of being overwritten.
    if (!phaseChanged && internalOrders !== null && internalOrders.has(JSON.stringify(snapshot.items.map(item => item.workspaceId)))) {
      notifyListener();
      return;
    }
    if (snapshot.phase === 'ready') {
      syncBaseOrderWithSource(snapshot);
      if (pinnedIds.length > 0 && !failureLatch) {
        if (busy) sourceChangedDuringBusy = true;
        else {
          const desired = computeDesiredOrder(new Set(pinnedIds), baseOrder);
          runReconciliation(desired).then(() => notifyListener()).catch(() => notifyListener());
        }
      }
    }
    notifyListener();
  }

  function handleStorageEvent(event) {
    if (disposed) return;
    if (event.storageArea !== win.localStorage) return;
    // A key of null means another tab cleared the whole storage area.
    if (event.key !== 'dsh-folding-windows:project-pins:v1' && event.key !== null) return;
    let newPinned;
    let newBase;
    if (event.newValue === null) {
      // Another tab cleared the preference: drop the pins, keep the ordinary
      // order this tab already knows, and hand that order back to DSH.
      newPinned = [];
      newBase = [...baseOrder];
    } else {
      try {
        const parsed = JSON.parse(event.newValue);
        newPinned = validIds(parsed?.pinnedIds);
        newBase = validIds(parsed?.baseOrder);
      } catch (e) {
        return;
      }
    }
    if (JSON.stringify({ pinnedIds: newPinned, baseOrder: newBase }) === JSON.stringify({ pinnedIds, baseOrder })) return;
    failureLatch = false;
    if (busy) {
      pendingStorageUpdate = { newPinned, newBase };
      return;
    }
    applyStoredState({ newPinned, newBase });
    runReconciliation(computeDesiredOrder(new Set(pinnedIds), baseOrder))
      .then(() => notifyListener()).catch(() => notifyListener());
  }

  const initialPersisted = loadPersistedState();
  pinnedIds = initialPersisted.pinnedIds;
  baseOrder = initialPersisted.baseOrder;
  sourceUnsubscribe = service.list.subscribe(handleSourceUpdate);
  win.addEventListener('storage', handleStorageEvent);
  if (lastSnapshotPhase === 'ready') {
    syncBaseOrderWithSource();
    if (pinnedIds.length > 0) {
      const pinnedSet = new Set(pinnedIds);
      const desired = computeDesiredOrder(pinnedSet, baseOrder);
      runReconciliation(desired).catch(() => {});
    }
  }

  return { getState, subscribe, toggle, dispose };
}

function installProjectPinning(doc, win, service) {
  if (!doc || !win) return function dispose() {};
  if (typeof createProjectPinController !== 'function' || !service || !service.list
    || typeof service.list.getSnapshot !== 'function' || typeof service.list.subscribe !== 'function'
    || typeof service.insertBefore !== 'function') return function dispose() {};

  // Dispose existing runtime if present
  if (win.__dshProjectPinningRuntime__ && typeof win.__dshProjectPinningRuntime__.dispose === 'function') {
    win.__dshProjectPinningRuntime__.dispose();
    win.__dshProjectPinningRuntime__ = null;
  }

  // Initialize controller
  const controller = createProjectPinController(service, win);
  if (!controller) {
    return function dispose() {};
  }

  // Runtime state
  const runtime = { dispose: null };
  win.__dshProjectPinningRuntime__ = runtime;
  let disposed = false;
  const rowMap = new Map(); // Key: row DOM element, Value: { workspaceId, button }
  let currentLocale = 'en';
  let currentSearchButton = null;
  let scanScheduled = false;

  // ------------------------------
  // Style element
  // ------------------------------
  const styleEl = doc.createElement('style');
  styleEl.setAttribute('data-dsh-project-pin-style', '');
  styleEl.textContent = `
    [data-dsh-project-pin] {
      margin-left: auto;
      padding: 2px;
      background: transparent;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      color: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.2s;
      flex-shrink: 0;
      width: 20px;
      height: 20px;
    }
    [data-dsh-project-pin][aria-pressed="true"] {
      opacity: 1;
    }
    [role="treeitem"]:hover > [data-dsh-project-pin],
    [role="treeitem"]:focus > [data-dsh-project-pin],
    [role="treeitem"]:focus-within > [data-dsh-project-pin],
    [data-dsh-project-pin][aria-pressed="true"] {
      opacity: 1;
    }
    [data-dsh-project-pin]:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    [data-dsh-project-pin]:focus-visible {
      opacity: 1;
      outline: 2px solid Highlight;
      outline-offset: 2px;
    }
    [data-dsh-project-pin-notice] {
      padding: 4px 8px;
      flex: none;
      font-size: 12px;
      color: #d32f2f;
      display: none;
    }
    [data-dsh-project-pin-notice][data-visible="true"] {
      display: block;
    }
  `;
  (doc.head || doc.documentElement).appendChild(styleEl);

  // ------------------------------
  // Notice element
  // ------------------------------
  const noticeEl = doc.createElement('span');
  noticeEl.setAttribute('data-dsh-project-pin-notice', '');
  noticeEl.setAttribute('role', 'status');
  noticeEl.setAttribute('aria-live', 'polite');
  noticeEl.setAttribute('data-visible', 'false');

  // ------------------------------
  // Helper functions
  // ------------------------------
  function getLocale() {
    const searchBtn = currentSearchButton;
    if (!searchBtn) return /^zh/i.test(doc.documentElement?.lang || '') ? 'zh' : 'en';
    return searchBtn.getAttribute('aria-label') === '搜索会话' ? 'zh' : 'en';
  }

  function getErrorText() {
    return getLocale() === 'zh' ? '项目置顶失败，请重试。' : 'Could not pin project. Please try again.';
  }

  function getButtonText(items, workspaceId, isPinned) {
    const item = items.find(i => i.workspaceId === workspaceId);
    const title = item ? item.title : '';
    if (getLocale() === 'zh') {
      return isPinned ? `取消置顶项目 ${title}` : `置顶项目 ${title}`;
    } else {
      return isPinned ? `Unpin project ${title}` : `Pin project ${title}`;
    }
  }

  function createPinButton(workspaceId, isPinned, disabled, text) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('data-dsh-project-pin', workspaceId);
    button.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
    button.disabled = disabled;
    button.setAttribute('aria-label', text);
    button.setAttribute('title', text);

    // SVG pin icon
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const path = doc.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M16 9l3 3v2H5v-2l3-3V4H7V2h10v2h-1v5zM12 14v8');

    svg.appendChild(path);
    svg.setAttribute('aria-hidden', 'true');
    button.appendChild(svg);

    // Event handlers
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      controller.toggle(workspaceId).catch(() => {});
    });

    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.stopPropagation();
      }
    });

    button.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    return button;
  }

  function getListArea() {
    currentSearchButton = null;
    // Structural checks match SidebarRoot without relying on CSS-module names.
    // DSH 0.2.2 moved the New Session control out of the panel nav's parent, so
    // the sidebar is discovered from the panel nav itself and the workspace
    // region is found as its sibling subtree.
    foldingCompatEachPanelNav(doc, function visit(nav) {
      const sidebarRoot = foldingCompatResolveHost(nav);
      const sidebarColumn = foldingCompatResolveColumn(nav);
      if (!sidebarRoot || sidebarRoot.tagName !== 'DIV' || !sidebarColumn) return;
      for (const regionArea of sidebarRoot.children) {
        if (regionArea.tagName !== 'DIV') continue;
        for (const wsBrowser of regionArea.children) {
          if (wsBrowser.tagName !== 'DIV') continue;
          const searchBtn = wsBrowser.querySelector('button[aria-label="搜索会话"], button[aria-label="Search sessions"]');
          if (!searchBtn) continue;
          const listArea = Array.from(wsBrowser.children).find(child => child.querySelector('[role="tree"][aria-label="会话"], [role="tree"][aria-label="Sessions"]'));
          if (!listArea) continue;
          currentSearchButton = searchBtn;
          // A separate owned flex child avoids the search pill's clipping.
          if (noticeEl.parentElement !== wsBrowser) wsBrowser.insertBefore(noticeEl, listArea);
          return listArea;
        }
      }
    });
    return null;
  }

  function setAttributeIfChanged(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function setTextIfChanged(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  // ------------------------------
  // UI Update logic
  // ------------------------------
  function updateUI() {
    if (disposed) return;
    const listArea = getListArea();
    const sessionsTree = listArea?.querySelector('[role="tree"][aria-label="会话"], [role="tree"][aria-label="Sessions"]');
    const state = controller.getState();
    const { items, pinnedIds, busy, phase, error } = state;
    const validWorkspaceIds = new Set(items.map(item => item.workspaceId));
    const newLocale = getLocale();

    // Update locale if changed
    if (newLocale !== currentLocale) {
      currentLocale = newLocale;
      // Update all existing button labels
      for (const [row, { workspaceId, button }] of rowMap) {
        const isPinned = pinnedIds.includes(workspaceId);
        const text = getButtonText(items, workspaceId, isPinned);
        setAttributeIfChanged(button, 'aria-label', text);
        setAttributeIfChanged(button, 'title', text);
      }
      // Update notice if visible
      if (noticeEl.getAttribute('data-visible') === 'true') {
        setTextIfChanged(noticeEl, getErrorText());
      }
    }

    // Update notice visibility
    if (error === 'reorder_failed') {
      setTextIfChanged(noticeEl, getErrorText());
      setAttributeIfChanged(noticeEl, 'data-visible', 'true');
    } else {
      setAttributeIfChanged(noticeEl, 'data-visible', 'false');
      setTextIfChanged(noticeEl, '');
    }

    // Clean up invalid/detached rows
    for (const [row, { workspaceId, button }] of rowMap) {
      if (!doc.contains(row) || !sessionsTree?.contains(row)
        || row.getAttribute('role') !== 'treeitem'
        || row.getAttribute('data-row-key') !== 'workspace:' + workspaceId) {
        button.remove();
        rowMap.delete(row);
        continue;
      }
      if (!validWorkspaceIds.has(workspaceId)) {
        button.remove();
        rowMap.delete(row);
        continue;
      }

      // Restore button if removed by React
      if (!row.contains(button)) {
        const isPinned = pinnedIds.includes(workspaceId);
        const disabled = busy || phase === 'pending';
        const text = getButtonText(items, workspaceId, isPinned);
        const newButton = createPinButton(workspaceId, isPinned, disabled, text);
        row.appendChild(newButton);
        rowMap.set(row, { workspaceId, button: newButton });
        continue;
      }

      // Update button state
      const isPinned = pinnedIds.includes(workspaceId);
      const disabled = busy || phase === 'pending';
      const text = getButtonText(items, workspaceId, isPinned);

      if (button.getAttribute('aria-pressed') !== (isPinned ? 'true' : 'false')) {
        button.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
      }
      if (button.disabled !== disabled) {
        button.disabled = disabled;
      }
      if (button.getAttribute('aria-label') !== text) {
        button.setAttribute('aria-label', text);
      }
      if (button.getAttribute('title') !== text) {
        button.setAttribute('title', text);
      }
    }

    // Add buttons to new project rows
    if (!sessionsTree) return;

    // Stable semantic row keys support grouped and nested workspace views.
    const projectRows = sessionsTree.querySelectorAll('[role="treeitem"][data-row-key^="workspace:"]');
    for (const projectRow of projectRows) {

      const rowKey = projectRow.getAttribute('data-row-key');
      if (!rowKey || !rowKey.startsWith('workspace:')) continue;
      const workspaceId = rowKey.slice('workspace:'.length);
      if (!workspaceId || !validWorkspaceIds.has(workspaceId)) continue;

      // Skip if already in rowMap
      if (rowMap.has(projectRow)) continue;

      // Create and add button
      const isPinned = pinnedIds.includes(workspaceId);
      const disabled = busy || phase === 'pending';
      const text = getButtonText(items, workspaceId, isPinned);
      const button = createPinButton(workspaceId, isPinned, disabled, text);
      projectRow.appendChild(button);
      rowMap.set(projectRow, { workspaceId, button });
    }

    // Clean up rows that are no longer valid project rows
    for (const [row, { workspaceId, button }] of rowMap) {
      const rowKey = row.getAttribute('data-row-key');
      if (rowKey !== 'workspace:' + workspaceId) {
        button.remove();
        rowMap.delete(row);
      }
    }
  }

  // ------------------------------
  // Observers and subscriptions
  // ------------------------------
  function scheduleScan() {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    Promise.resolve().then(() => {
      scanScheduled = false;
      if (!disposed) updateUI();
    });
  }
  const unsubscribeController = controller.subscribe(scheduleScan);
  const domObserver = new win.MutationObserver(scheduleScan);
  domObserver.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-row-key', 'aria-label', 'role', 'lang'],
  });
  updateUI();

  // ------------------------------
  // Dispose function
  // ------------------------------
  function dispose() {
    if (disposed) return;
    disposed = true;

    // Disconnect observers
    domObserver.disconnect();

    // Clean up controller
    unsubscribeController();
    controller.dispose();

    // Remove all pin buttons
    for (const [row, { button }] of rowMap) {
      button.remove();
    }
    rowMap.clear();

    // Remove style and notice
    if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    if (noticeEl.parentNode) noticeEl.parentNode.removeChild(noticeEl);

    // Clear runtime reference
    if (win.__dshProjectPinningRuntime__ === runtime) {
      win.__dshProjectPinningRuntime__ = null;
    }
  }

  runtime.dispose = dispose;
  return dispose;
}

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

'use strict';

const PACKAGE_NAME = '@jiqinga/dsh-folding-windows';
const STORAGE_KEY = 'dsh-folding-windows:collapsed:v1';
const RUNTIME_KEY = '__dshFoldingWindowsRuntime__';

const NAV_SELECTOR = 'nav[aria-label="全局面板"],nav[aria-label="Global panels"]';
const NEW_SESSION_LABELS = ['新建会话', 'New session'];

const CONTROL_ATTR = 'data-dsh-folding-control';
const ROLE_ATTR = 'data-dsh-folding-role';
const EMPTY_ATTR = 'data-dsh-folding-empty';
const COLUMN_COLLAPSED_ATTR = 'data-dsh-folding-column-collapsed';
const HIDDEN_ATTR = 'data-dsh-folding-hidden';
const STYLE_ATTR = 'data-dsh-folding-style';

const CSS_TEXT = `
button[data-dsh-folding-control] {
  --dsh-folding-fg: rgba(0, 0, 0, 0.65);
  --dsh-folding-hover-bg: rgba(0, 0, 0, 0.06);
  --dsh-folding-focus: #2563eb;

  box-sizing: border-box;
  appearance: none;
  -webkit-appearance: none;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
  flex: 0 0 auto;
  height: 36px;
  margin: 0 0 4px;
  padding: 0 0 0 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsh-folding-fg));
  font: inherit;
  font-size: 14px;
  line-height: 1;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

button[data-dsh-folding-control] > [data-dsh-folding-role="label"] {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

button[data-dsh-folding-control] > [data-dsh-folding-role="count"] {
  order: 3;
  margin-left: auto;
  flex: 0 0 auto;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

button[data-dsh-folding-control] > [data-dsh-folding-role="arrow"] {
  order: 2;
  flex: 0 0 auto;
  width: 24px;
  font-size: 12px;
  text-align: center;
}

button[data-dsh-folding-control]:hover {
  /* The workspace header has no row-level hover fill; keep the tools row flat too. */
  background-color: transparent;
}

button[data-dsh-folding-control]:focus-visible {
  outline: 2px solid var(--dsh-folding-focus);
  outline-offset: 2px;
}

@media (prefers-color-scheme: dark) {
  button[data-dsh-folding-control] {
    --dsh-folding-fg: rgba(255, 255, 255, 0.7);
    --dsh-folding-hover-bg: rgba(255, 255, 255, 0.08);
    --dsh-folding-focus: #93c5fd;
  }
}

@media (prefers-reduced-motion: reduce) {
  button[data-dsh-folding-control] {
    transition: none;
  }
}

nav[aria-label][data-dsh-folding-hidden="true"] {
  display: none !important;
}

button[data-dsh-folding-control][data-dsh-folding-empty="true"],
button[data-dsh-folding-control][data-dsh-folding-column-collapsed="true"] {
  display: none !important;
}
`;

function isElement(node) {
  return !!node && node.nodeType === 1;
}

function isNewSessionButton(element) {
  if (!isElement(element) || element.tagName !== 'BUTTON') return false;
  const label = element.getAttribute('aria-label');
  return label === NEW_SESSION_LABELS[0] || label === NEW_SESSION_LABELS[1];
}

function isValidSidebarNav(nav) {
  if (!isElement(nav) || nav.tagName !== 'NAV') return false;

  const navLabel = nav.getAttribute('aria-label');
  if (navLabel !== '全局面板' && navLabel !== 'Global panels') return false;

  const sidebarRoot = nav.parentElement;
  if (!sidebarRoot) return false;

  // DSH 0.2.2 wraps the nav in extra layout levels (div.scrollRegion >
  // div.scrollArea) and moves the New Session control out of the nav's parent,
  // so the column is resolved by walking up to the ancestor that owns that
  // control instead of assuming a fixed nesting depth.
  const column = foldingCompatResolveColumn(nav);
  if (!column) return false;

  // The fold control is inserted immediately before the nav, which needs a parent.
  return !!nav.parentElement;
}

function getNavItemCount(nav) {
  let count = 0;
  for (const child of Array.from(nav.children)) {
    const isDirectButton = child.tagName === 'BUTTON' && child.hasAttribute('aria-label');
    const hasWrappedButton = typeof child.querySelector === 'function'
      && child.querySelector('button[aria-label]') !== null;
    if (isDirectButton || hasWrappedButton) count += 1;
  }
  return count;
}

function isSidebarColumnCollapsed(nav) {
  return foldingCompatIsColumnCollapsed(foldingCompatResolveColumn(nav));
}

function setAttributeIfChanged(element, name, value) {
  if (element.getAttribute(name) === value) return;
  element.setAttribute(name, value);
}

function setTextIfChanged(element, text) {
  if (element.textContent === text) return;
  element.textContent = text;
}

function readCollapsed(win) {
  try {
    return win.localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch (err) {
    return true;
  }
}

exports.apply = function apply(ctx) {
  if (!ctx || typeof ctx.effect !== 'function') {
    throw new TypeError(PACKAGE_NAME + ': ctx.effect is required');
  }

  const dispose = ctx.effect(function installEffect() {
    return exports.install(document, window);
  }, 'folding-windows: sidebar');

  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaces'], function (owner) {
      owner.effect(function () {
        return exports.installProjectPinning(document, window, owner.get('workspaces'));
      }, 'folding-windows: project pinning');
    });
  }
  return dispose;
};

exports.installProjectPinning = installProjectPinning;

exports.install = function install(doc, win) {
  if (!doc || !win) {
    throw new TypeError(PACKAGE_NAME + ': install(document, window) requires both arguments');
  }

  const previous = win[RUNTIME_KEY];
  if (previous && typeof previous.dispose === 'function') {
    previous.dispose();
  }
  if (win[RUNTIME_KEY]) {
    delete win[RUNTIME_KEY];
  }

  const instances = new Map();
  let disposed = false;
  let scheduled = false;
  let collapsed = readCollapsed(win);
  let navIdSequence = 0;

  const style = doc.createElement('style');
  style.setAttribute('type', 'text/css');
  style.setAttribute(STYLE_ATTR, 'true');
  style.textContent = CSS_TEXT;

  Array.from(doc.querySelectorAll('style[' + STYLE_ATTR + ']')).forEach(function removeOwnStyle(node) {
    if (node !== style && node.parentNode) node.parentNode.removeChild(node);
  });
  (doc.head || doc.documentElement).appendChild(style);

  const disposeWorkspaces = installWorkspaceFolding(doc, win);

  function queueScan() {
    if (disposed || scheduled) return;
    scheduled = true;
    Promise.resolve().then(function runScan() {
      scheduled = false;
      if (!disposed) scan();
    });
  }

  function onMutation(mutations) {
    if (disposed) return;

    for (const mutation of mutations) {
      const target = mutation.target;
      const element = isElement(target) ? target : target && target.parentElement;
      if (!element) continue;
      if (element === style || element.contains(style)) continue;
      if (typeof element.closest === 'function' && element.closest('[' + CONTROL_ATTR + ']')) continue;
      queueScan();
      return;
    }
  }

  function ensureNavId(nav, record) {
    if (record.hadId === undefined) {
      record.hadId = nav.hasAttribute('id');
      record.oldId = nav.getAttribute('id');
    }

    const currentId = nav.getAttribute('id');
    if (currentId) return currentId;

    if (!record.generatedId) {
      navIdSequence += 1;
      record.generatedId = 'dsh-folding-windows-nav-' + navIdSequence;
    }

    if (nav.getAttribute('id') !== record.generatedId) {
      nav.setAttribute('id', record.generatedId);
    }
    return record.generatedId;
  }

  function applyNavVisibility(nav, record, count) {
    if (record.hadHidden === undefined) {
      record.hadHidden = nav.hasAttribute(HIDDEN_ATTR);
      record.oldHidden = nav.getAttribute(HIDDEN_ATTR);
    }

    const shouldHide = collapsed && count > 0;
    const current = nav.getAttribute(HIDDEN_ATTR);

    if (shouldHide) {
      if (current !== 'true') nav.setAttribute(HIDDEN_ATTR, 'true');
      return;
    }

    if (current !== null) nav.removeAttribute(HIDDEN_ATTR);
  }

  function updateRecord(record) {
    const nav = record.nav;
    const control = record.control;

    record.english = nav.getAttribute('aria-label') === 'Global panels';
    record.count = getNavItemCount(nav);

    const expanded = !collapsed;
    const labelText = record.english ? 'Tools' : '功能区';
    const arrowText = expanded ? '▾' : '▸';
    const titleText = expanded
      ? (record.english ? 'Collapse tools area' : '收起功能区')
      : (record.english ? 'Expand tools area' : '展开功能区');

    setTextIfChanged(record.label, labelText);
    setTextIfChanged(record.countElement, String(record.count));
    setTextIfChanged(record.arrow, arrowText);

    setAttributeIfChanged(control, 'aria-expanded', expanded ? 'true' : 'false');
    setAttributeIfChanged(control, 'aria-controls', ensureNavId(nav, record));
    setAttributeIfChanged(control, 'title', titleText);
    setAttributeIfChanged(control, EMPTY_ATTR, record.count > 0 ? 'false' : 'true');

    record.columnCollapsed = isSidebarColumnCollapsed(nav);
    setAttributeIfChanged(control, COLUMN_COLLAPSED_ATTR, record.columnCollapsed ? 'true' : 'false');

    applyNavVisibility(nav, record, record.count);
  }

  function createRecord(nav) {
    const control = doc.createElement('button');
    control.setAttribute('type', 'button');
    control.setAttribute(CONTROL_ATTR, 'true');
    control.setAttribute('data-dsh-folding-section', 'tools');
    control.setAttribute(EMPTY_ATTR, 'false');
    control.setAttribute(COLUMN_COLLAPSED_ATTR, 'false');

    const label = doc.createElement('span');
    label.setAttribute(ROLE_ATTR, 'label');

    const countElement = doc.createElement('span');
    countElement.setAttribute(ROLE_ATTR, 'count');

    const arrow = doc.createElement('span');
    arrow.setAttribute(ROLE_ATTR, 'arrow');
    arrow.setAttribute('aria-hidden', 'true');

    control.appendChild(label);
    control.appendChild(countElement);
    control.appendChild(arrow);

    const record = {
      nav: nav,
      control: control,
      label: label,
      countElement: countElement,
      arrow: arrow,
      onClick: null,
      english: false,
      count: 0,
      columnCollapsed: false,
      hadId: undefined,
      oldId: null,
      generatedId: null,
      hadHidden: undefined,
      oldHidden: null
    };

    record.onClick = function onClick() {
      setCollapsed(!collapsed);
    };
    control.addEventListener('click', record.onClick);

    const placement = foldingCompatResolveControlPlacement(nav);
    if (placement) {
      placement.parent.insertBefore(control, placement.before);
    }

    return record;
  }

  function restoreNavAttributes(nav, record) {
    if (record.hadHidden !== undefined) {
      const current = nav.getAttribute(HIDDEN_ATTR);
      if (record.hadHidden) {
        if (current !== record.oldHidden) {
          if (record.oldHidden === null) {
            nav.removeAttribute(HIDDEN_ATTR);
          } else {
            nav.setAttribute(HIDDEN_ATTR, record.oldHidden);
          }
        }
      } else if (current !== null) {
        nav.removeAttribute(HIDDEN_ATTR);
      }
    }

    if (record.generatedId && nav.getAttribute('id') === record.generatedId) {
      if (record.hadId) {
        const oldId = record.oldId === null ? '' : record.oldId;
        if (nav.getAttribute('id') !== oldId) nav.setAttribute('id', oldId);
      } else {
        nav.removeAttribute('id');
      }
    }
  }

  function removeRecord(record) {
    const control = record.control;
    if (control.parentNode) control.parentNode.removeChild(control);
    if (record.onClick) control.removeEventListener('click', record.onClick);
    restoreNavAttributes(record.nav, record);
  }

  function updateAllStates() {
    for (const record of instances.values()) {
      updateRecord(record);
    }
  }

  function moveFocusOutOfNav(active) {
    if (!isElement(active)) return;

    for (const record of instances.values()) {
      if (record.nav.contains(active)) {
        if (record.count > 0 && record.columnCollapsed !== true) {
          record.control.focus();
        } else if (typeof active.blur === 'function') {
          active.blur();
        }
        return;
      }
    }
  }

  function setCollapsed(next, options) {
    if (next === collapsed) return;
    collapsed = next;

    if (!options || options.persist !== false) {
      try {
        win.localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
      } catch (err) {
        // Storage may be unavailable or full; in-memory state still works.
      }
    }

    const active = doc.activeElement;
    updateAllStates();
    if (collapsed) moveFocusOutOfNav(active);
  }

  function onStorage(event) {
    if (!event || event.key !== STORAGE_KEY) return;
    if (event.newValue === 'true') {
      setCollapsed(true, { persist: false });
    } else if (event.newValue === 'false') {
      setCollapsed(false, { persist: false });
    }
  }

  function scan() {
    if (disposed) return;

    for (const [nav, record] of Array.from(instances.entries())) {
      if (!nav.isConnected || !record.control.isConnected || !isValidSidebarNav(nav)) {
        removeRecord(record);
        instances.delete(nav);
      }
    }

    for (const nav of Array.from(doc.querySelectorAll(NAV_SELECTOR))) {
      if (!isValidSidebarNav(nav)) continue;

      let record = instances.get(nav);
      if (!record) {
        record = createRecord(nav);
        instances.set(nav, record);
      } else {
        const placement = foldingCompatResolveControlPlacement(nav);
        if (placement && !foldingCompatHasControlPlacement(record.control, placement)) {
          placement.parent.insertBefore(record.control, placement.before);
        }
      }

      updateRecord(record);
    }

    if (collapsed) moveFocusOutOfNav(doc.activeElement);
  }

  const observer = new win.MutationObserver(onMutation);
  if (doc.documentElement) {
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-sidebar-collapsed', 'class']
    });
  }

  win.addEventListener('storage', onStorage);
  scan();
  queueScan();

  const instance = {
    dispose: function dispose() {
      if (disposed) return;

      const current = win[RUNTIME_KEY];
      if (current && current !== instance) {
        disposed = true;
        return;
      }

      cleanup();
    }
  };

  function cleanup() {
    disposed = true;
    observer.disconnect();
    win.removeEventListener('storage', onStorage);
    disposeWorkspaces();

    for (const record of Array.from(instances.values())) {
      removeRecord(record);
    }
    instances.clear();

    if (style.parentNode) style.parentNode.removeChild(style);
    if (win[RUNTIME_KEY] === instance) delete win[RUNTIME_KEY];
  }

  win[RUNTIME_KEY] = instance;
  return instance.dispose;
};

return module.exports;
} });
