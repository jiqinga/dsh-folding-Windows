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
