import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { startPreview, navigation, workspace } from '../tools/preview.mjs'

let browser
let preview
before(async () => {
  preview = await startPreview()
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
})
after(async () => {
  await browser?.close()
  await preview?.close()
})

async function withPage(run, query = '') {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(preview.url + query)
    await page.waitForFunction(() => typeof window.foldingPlugin?.install === 'function')
    await run(page)
    assert.deepEqual(errors, [], 'the browser must not report uncaught errors')
  } finally {
    await context.close()
  }
}

const nav = page => page.locator('.sidebar-root > nav[aria-label="全局面板"]')
const toolsControls = page => page.locator('.sidebar-root > button[aria-controls="global-panels"]')
const workspaceRegion = page => page.locator('.sidebar-root > .region')
async function toggle(page) {
  await page.waitForFunction(() => {
    const region = document.querySelector('.sidebar-root > nav[aria-label="全局面板"]')
    return region?.id && [...document.querySelectorAll('button[aria-controls]')].some(button => button.getAttribute('aria-controls') === region.id)
  })
  const regionId = await nav(page).getAttribute('id')
  return page.locator(`button[aria-controls=${JSON.stringify(regionId)}]`)
}
async function expectExpanded(page, expanded) {
  const button = await toggle(page)
  await page.waitForFunction(expected => {
    const region = document.querySelector('.sidebar-root > nav[aria-label="全局面板"]')
    const control = [...document.querySelectorAll('button[aria-controls]')].find(item => item.getAttribute('aria-controls') === region?.id)
    return control?.getAttribute('aria-expanded') === String(expected)
      && (getComputedStyle(region).display !== 'none') === expected
  }, expanded)
  assert.equal(await button.getAttribute('aria-expanded'), String(expanded))
}

async function workspaceToggle(page) {
  await page.waitForFunction(() => {
    const control = document.querySelector('button[data-dsh-folding-section="workspaces"]')
    return control && control.getAttribute('aria-controls')
  })
  return page.locator('button[data-dsh-folding-section="workspaces"]').first()
}

async function expectWorkspaceExpanded(page, expanded) {
  const control = await workspaceToggle(page)
  await page.waitForFunction(expected => {
    const button = document.querySelector('button[data-dsh-folding-section="workspaces"]')
    const id = button?.getAttribute('aria-controls')
    const target = id ? document.getElementById(id) : null
    const list = target || document.querySelector('.workspace-list-area') || document.querySelector('.workspace-tree')
    return button?.getAttribute('aria-expanded') === String(expected)
      && !!list && (getComputedStyle(list).display !== 'none') === expected
  }, expanded)
  assert.equal(await control.getAttribute('aria-expanded'), String(expanded))
}

test('folds the real flex navigation, keeps workspace visible, and preserves panel clicks', async () => {
  await withPage(async page => {
    await expectExpanded(page, false)
    await (await toggle(page)).click()
    await expectExpanded(page, true)
    assert.equal(await nav(page).evaluate(element => getComputedStyle(element).display), 'flex')
    await (await toggle(page)).click()
    await expectExpanded(page, false)
    assert.equal(await page.locator('.region').isVisible(), true)
    assert.equal(await page.getByRole('navigation', { name: '页面目录' }).isVisible(), true)
    await (await toggle(page)).click()
    await expectExpanded(page, true)
    await page.getByRole('button', { name: 'SSH', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.clickedPanels), ['SSH'])
  })
})

test('keyboard can reopen the region and reload preserves the chosen fold state', async () => {
  await withPage(async page => {
    await expectExpanded(page, false)
    await page.reload()
    await expectExpanded(page, false)
    await (await toggle(page)).focus()
    await page.keyboard.press('Enter')
    await expectExpanded(page, true)
    await page.keyboard.press('Space')
    await expectExpanded(page, false)
    await page.reload()
    await expectExpanded(page, false)
  })
})

test('a similarly named navigation outside the sidebar remains untouched', async () => {
  await withPage(async page => {
    await page.locator('main').evaluate(element => {
      element.insertAdjacentHTML('beforeend', '<nav id="unrelated-panels" aria-label="全局面板"><button type="button" aria-label="页面功能">页面功能</button></nav>')
    })
    const original = await page.locator('#unrelated-panels').evaluate(element => element.outerHTML)
    await (await toggle(page)).click()
    await expectExpanded(page, true)
    await (await toggle(page)).click()
    await expectExpanded(page, false)
    assert.equal(await page.locator('#unrelated-panels').isVisible(), true)
    assert.equal(await page.locator('#unrelated-panels').evaluate(element => element.outerHTML), original)
    assert.equal(await page.locator('main button[aria-controls]').count(), 0)
  })
})

test('navigation can appear late, update its count, and remount without duplicate controls', async () => {
  await withPage(async page => {
    assert.equal(await toolsControls(page).count(), 0)
    await page.locator('.region').evaluate((region, markup) => region.insertAdjacentHTML('beforebegin', markup), navigation())
    const control = await toggle(page)
    assert.match(await control.textContent(), /7/)
    await nav(page).evaluate(element => {
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.setAttribute('aria-label', '新功能')
      entry.textContent = '新功能'
      element.append(entry)
    })
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-controls]')].some(button => /8/.test(button.textContent)))
    await expectExpanded(page, false)
    await nav(page).evaluate((element, markup) => { element.outerHTML = markup }, navigation())
    await expectExpanded(page, false)
    assert.equal(await toolsControls(page).count(), 1)
    assert.match(await (await toggle(page)).textContent(), /7/)
  }, '?empty=1')
})

test('counts panel entries wrapped by modern sidebar containers', async () => {
  await withPage(async page => {
    await nav(page).evaluate(element => {
      element.innerHTML = [
        '<div class="panel-item"><button type="button" aria-label="插件">插件</button></div>',
        '<div class="panel-item"><button type="button" aria-label="插件市场">插件市场</button><button type="button" aria-label="固定">固定</button></div>'
      ].join('')
    })
    await page.waitForFunction(() => {
      const control = document.querySelector('button[data-dsh-folding-section="tools"]')
      return control?.textContent.includes('2') && getComputedStyle(control).display !== 'none'
    })
    const control = page.locator('button[data-dsh-folding-section="tools"]')
    assert.equal(await control.getAttribute('data-dsh-folding-empty'), 'false')
    assert.match(await control.textContent(), /2/)
  })
})

test('injects the workspace fold button into the existing workspace header', async () => {
  await withPage(async page => {
    const tools = page.locator('button[data-dsh-folding-section="tools"]')
    const workspace = page.locator('button[data-dsh-folding-section="workspaces"]')
    await page.waitForFunction(() => {
      const header = document.querySelector('.workspace-header')
      const control = document.querySelector('button[data-dsh-folding-section="workspaces"]')
      return header && control && header.contains(control)
    })
    // The tools control stays in persistent chrome above the scroll area.
    assert.equal(await page.locator('.sidebar-root > button[data-dsh-folding-section="tools"]').count(), 1)
    assert.equal(await page.locator('.workspace-header > button[data-dsh-folding-section="workspaces"]').count(), 1)
    // The fold button follows the "工作区" caption instead of preceding it.
    assert.equal(await page.evaluate(() => {
      const header = document.querySelector('.workspace-header')
      const label = header.querySelector('.workspace-label')
      const control = header.querySelector('button[data-dsh-folding-section="workspaces"]')
      if (!label || !control) return false
      return !!(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)
    }), true)
    assert.equal(await page.evaluate(() => {
      const scrollport = document.querySelector('[data-sidebar-scrollport]')
      const control = document.querySelector('button[data-dsh-folding-section="tools"]')
      return !!scrollport && !!control && !scrollport.contains(control)
    }), true)

    await page.locator('[data-sidebar-scrollport]').evaluate(scrollport => {
      scrollport.style.height = '120px'
      scrollport.style.overflow = 'auto'
      const filler = document.createElement('div')
      filler.style.height = '800px'
      scrollport.appendChild(filler)
      scrollport.scrollTop = scrollport.scrollHeight
    })
    const toolsRect = await tools.evaluate(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom } })
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    assert.ok(toolsRect.top >= 0 && toolsRect.bottom <= viewportHeight)

    await workspace.click()
    await page.waitForFunction(() => {
      const control = document.querySelector('button[data-dsh-folding-section="workspaces"]')
      const id = control?.getAttribute('aria-controls')
      const target = id ? document.getElementById(id) : document.querySelector('.workspace-list-area')
      return control?.getAttribute('aria-expanded') === 'false' && target && getComputedStyle(target).display === 'none'
    })
    assert.equal(await page.locator('.workspace-header').isVisible(), true)
    assert.equal(await page.locator('.workspace-header button[aria-label="搜索会话"]').isVisible(), true)
    assert.equal(await page.locator('.workspace-header button[aria-label="添加工作区"]').isVisible(), true)
    await workspace.click()
    await page.waitForFunction(() => {
      const control = document.querySelector('button[data-dsh-folding-section="workspaces"]')
      const id = control?.getAttribute('aria-controls')
      const target = id ? document.getElementById(id) : document.querySelector('.workspace-list-area')
      return control?.getAttribute('aria-expanded') === 'true' && target && getComputedStyle(target).display !== 'none'
    })
    // A click on the blank part of the header row also folds the section.
    await page.locator('.workspace-header').click({ position: { x: 120, y: 18 } })
    await page.waitForFunction(() => {
      const control = document.querySelector('button[data-dsh-folding-section="workspaces"]')
      const id = control?.getAttribute('aria-controls')
      const target = id ? document.getElementById(id) : document.querySelector('.workspace-list-area')
      return control?.getAttribute('aria-expanded') === 'false' && target && getComputedStyle(target).display === 'none'
    })
  }, '?layout=modern')
})

test('whole-sidebar collapse keeps the folding control hidden and retains local state', async () => {
  await withPage(async page => {
    await expectExpanded(page, false)
    await page.locator('#frame').evaluate(element => element.setAttribute('data-sidebar-collapsed', 'true'))
    await page.waitForFunction(() => {
      const region = document.querySelector('.sidebar-root > nav[aria-label="全局面板"]')
      const control = [...document.querySelectorAll('button[aria-controls]')].find(item => item.getAttribute('aria-controls') === region.id)
      return getComputedStyle(control).display === 'none' || control.closest('[hidden]') !== null
    })
    assert.equal(await (await toggle(page)).isVisible(), false)
    await page.locator('#frame').evaluate(element => element.removeAttribute('data-sidebar-collapsed'))
    assert.equal(await (await toggle(page)).isVisible(), true)
    await expectExpanded(page, false)
  })
})

test('replacement install is unique and an old disposer cannot tear down the replacement', async () => {
  await withPage(async page => {
    await toggle(page)
    await page.evaluate(() => {
      window.oldDisposeFolding = window.disposeFolding
      window.disposeFolding = window.installFolding()
      window.oldDisposeFolding()
    })
    assert.equal(await toolsControls(page).count(), 1)
    await (await toggle(page)).click()
    await expectExpanded(page, true)
  })
})

test('dispose restores preexisting navigation attributes and removes the control', async () => {
  await withPage(async page => {
    const original = await nav(page).evaluate(element => {
      element.id = 'existing-panel-region'
      element.setAttribute('aria-hidden', 'false')
      element.setAttribute('style', 'color: rgb(1, 2, 3);')
      return { attributes: [...element.attributes].map(attribute => [attribute.name, attribute.value]).sort(), html: element.innerHTML }
    })
    await page.evaluate(() => { window.disposeFolding = window.installFolding() })
    await expectExpanded(page, false)
    await page.evaluate(() => { window.disposeFolding() })
    assert.equal(await page.locator('.sidebar-root button[aria-controls]').count(), 0)
    assert.deepEqual(await nav(page).evaluate(element => ({ attributes: [...element.attributes].map(attribute => [attribute.name, attribute.value]).sort(), html: element.innerHTML })), original)
    assert.equal(await nav(page).evaluate(element => getComputedStyle(element).display), 'flex')
  }, '?no-auto=1')
})

test('blocked localStorage does not prevent folding, reopening, or disposal', async () => {
  await withPage(async page => {
    await page.evaluate(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage unavailable', 'SecurityError') } })
      window.disposeFolding = window.installFolding()
    })
    await expectExpanded(page, false)
    await expectWorkspaceExpanded(page, true)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, false)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, true)
    await (await toggle(page)).click()
    await expectExpanded(page, true)
    await (await toggle(page)).click()
    await expectExpanded(page, false)
    await page.evaluate(() => { window.disposeFolding() })
    assert.equal(await nav(page).evaluate(element => getComputedStyle(element).display), 'flex')
  }, '?no-auto=1')
})

test('DSH apply registers and disposes the browser feature through ctx.effect', async () => {
  await withPage(async page => {
    const effects = await page.evaluate(() => {
      window.dshDisposers = []
      window.foldingPlugin.apply({
        effect(factory) {
          const dispose = factory()
          if (typeof dispose === 'function') window.dshDisposers.push(dispose)
          return dispose
        },
      })
      return window.dshDisposers.length
    })
    assert.ok(effects > 0, 'apply must put its cleanup under the DSH lifecycle')
    await expectExpanded(page, false)
    await page.evaluate(() => {
      for (const dispose of window.dshDisposers.reverse()) dispose()
    })
    assert.equal(await page.locator('.sidebar-root button[aria-controls]').count(), 0)
    assert.equal(await nav(page).evaluate(element => getComputedStyle(element).display), 'flex')
  }, '?no-auto=1')
})

test('recognizes the official English sidebar navigation', async () => {
  await withPage(async page => {
    await page.evaluate(() => {
      document.documentElement.lang = 'en'
      document.querySelector('.sidebar-root > nav').setAttribute('aria-label', 'Global panels')
      document.querySelector('.new-session').setAttribute('aria-label', 'New session')
      window.disposeFolding = window.installFolding()
    })
    const region = page.locator('.sidebar-root > nav[aria-label="Global panels"]')
    const control = page.locator('button[aria-controls="global-panels"]')
    await control.waitFor()
    assert.equal(await control.getAttribute('aria-expanded'), 'false')
    assert.equal(await region.evaluate(element => getComputedStyle(element).display), 'none')
    await control.click()
    assert.equal(await control.getAttribute('aria-expanded'), 'true')
    assert.equal(await region.evaluate(element => getComputedStyle(element).display), 'flex')
  }, '?no-auto=1')
})

test('a cross-tab fold moves focus out of hidden entries and keeps them out of Tab order', async () => {
  await withPage(async page => {
    await (await toggle(page)).click()
    await expectExpanded(page, true)
    await (await toggle(page)).click()
    await expectExpanded(page, false)
    const collapsedStorage = await page.evaluate(() => Object.entries(localStorage))
    assert.ok(collapsedStorage.length > 0, 'the chosen state must be persisted for cross-tab updates')
    await (await toggle(page)).click()
    await expectExpanded(page, true)
    const writer = await page.context().newPage()
    await writer.goto(preview.url + '?no-auto=1')
    await page.bringToFront()
    await page.getByRole('button', { name: 'SSH', exact: true }).focus()
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'SSH')
    await writer.evaluate(entries => {
      for (const [key, value] of entries) localStorage.setItem(key, value)
    }, collapsedStorage)
    await expectExpanded(page, false)
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-controls')), await nav(page).getAttribute('id'))
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement.closest('.sidebar-root > nav') !== null), false)
    await writer.close()
  })
})

test('workspace folding still finds the browser when DSH nests it inside slot wrappers', async () => {
  await withPage(async page => {
    assert.equal(await page.locator('#workspace-region > .slot > .workspace-browser').count(), 1)
    await expectWorkspaceExpanded(page, true)
    const control = await workspaceToggle(page)
    await control.click()
    await expectWorkspaceExpanded(page, false)
    assert.equal(await page.locator('.workspace-header').isVisible(), true)
    assert.equal(await page.locator('.workspace-tree').isVisible(), false)
    await control.click()
    await expectWorkspaceExpanded(page, true)
  }, '?wrap=1')
})

test('workspace folding hides only the session list and keeps the header controls reachable', async () => {
  await withPage(async page => {
    await expectWorkspaceExpanded(page, true)
    const control = await workspaceToggle(page)
    assert.equal(await control.getAttribute('data-dsh-folding-section'), 'workspaces')
    assert.equal(await control.getAttribute('data-dsh-folding-in-header'), 'true')
    const header = page.locator('.workspace-header')
    const before = await workspaceRegion(page).evaluate(element => element.innerHTML)
    const settingsBottom = await page.locator('.foot-area').evaluate(element => element.getBoundingClientRect().bottom)
    await control.click()
    await expectWorkspaceExpanded(page, false)
    assert.equal(await header.isVisible(), true)
    assert.equal(await page.getByRole('button', { name: '搜索会话', exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('button', { name: '添加工作区', exact: true }).isVisible(), true)
    assert.equal(await page.locator('.session-row').first().isVisible(), false)
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).isVisible(), true)
    assert.equal(await page.locator('.foot-area').evaluate(element => element.getBoundingClientRect().bottom), settingsBottom)
    await control.focus()
    await page.keyboard.press('Enter')
    await expectWorkspaceExpanded(page, true)
    assert.equal(await workspaceRegion(page).evaluate(element => element.innerHTML), before)
    await page.locator('[data-session="today"]').click()
    assert.deepEqual(await page.evaluate(() => window.clickedSessions), ['today'])
    await control.focus()
    await page.keyboard.press('Space')
    await expectWorkspaceExpanded(page, false)
  })
})

test('workspace and tools keep independent persisted state and honor the legacy tools key', async () => {
  await withPage(async page => {
    await page.evaluate(() => {
      localStorage.setItem('dsh-folding-windows:collapsed:v1', 'false')
      window.disposeFolding = window.installFolding()
    })
    await expectExpanded(page, true)
    await expectWorkspaceExpanded(page, true)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, false)
    await expectExpanded(page, true)
    await page.evaluate(() => { window.disposeFolding(); window.disposeFolding = window.installFolding() })
    await expectWorkspaceExpanded(page, false)
    await expectExpanded(page, true)
    await (await toggle(page)).click()
    await expectExpanded(page, false)
    await expectWorkspaceExpanded(page, false)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, true)
    await expectExpanded(page, false)
    await page.reload()
    await page.evaluate(() => { window.disposeFolding = window.installFolding() })
    await expectExpanded(page, false)
    await expectWorkspaceExpanded(page, true)
    await (await workspaceToggle(page)).click()
    await (await toggle(page)).click()
    await page.reload()
    await page.evaluate(() => { window.disposeFolding = window.installFolding() })
    await expectExpanded(page, true)
    await expectWorkspaceExpanded(page, false)
  }, '?no-auto=1')
})

test('workspace control works without global panels and does not touch a workspace outside the sidebar', async () => {
  await withPage(async page => {
    assert.equal(await nav(page).count(), 0)
    await expectWorkspaceExpanded(page, true)
    await page.locator('main').evaluate((element, markup) => element.insertAdjacentHTML('beforeend', markup.replace('id="workspace-region"', 'id="unrelated-workspace"')), workspace())
    const unrelated = await page.locator('#unrelated-workspace').evaluate(element => element.outerHTML)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, false)
    assert.equal(await page.locator('#unrelated-workspace').isVisible(), true)
    assert.equal(await page.locator('#unrelated-workspace').evaluate(element => element.outerHTML), unrelated)
    assert.equal(await page.locator('main button[aria-controls]').count(), 0)
    assert.equal(await page.locator('button[data-dsh-folding-section="workspaces"]').count(), 1)
  }, '?empty=1')
})

test('workspace can mount late and remount with its remembered state without duplicate controls', async () => {
  await withPage(async page => {
    await workspaceRegion(page).evaluate(element => element.remove())
    await page.evaluate(() => { window.disposeFolding = window.installFolding() })
    assert.equal(await page.locator('button[data-dsh-folding-section="workspaces"]').count(), 0)
    await page.locator('.foot-area').evaluate((element, markup) => element.insertAdjacentHTML('beforebegin', markup), workspace())
    await expectWorkspaceExpanded(page, true)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, false)
    await workspaceRegion(page).evaluate((element, markup) => { element.outerHTML = markup }, workspace())
    await expectWorkspaceExpanded(page, false)
    assert.equal(await page.locator('button[data-dsh-folding-section="workspaces"]').count(), 1)
    await page.evaluate(() => {
      const oldDispose = window.disposeFolding
      window.disposeFolding = window.installFolding()
      oldDispose()
    })
    await expectWorkspaceExpanded(page, false)
    assert.equal(await page.locator('button[data-dsh-folding-section="workspaces"]').count(), 1)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, true)
  }, '?no-auto=1')
})

test('workspace disposal restores preexisting attributes and generated ids exactly', async () => {
  await withPage(async page => {
    const original = await workspaceRegion(page).evaluate(element => {
      element.id = ''
      element.setAttribute('aria-hidden', 'false')
      element.setAttribute('style', 'color: rgb(1, 2, 3);')
      return { attributes: [...element.attributes].map(attribute => [attribute.name, attribute.value]).sort(), html: element.innerHTML }
    })
    await page.evaluate(() => { window.disposeFolding = window.installFolding() })
    await expectWorkspaceExpanded(page, true)
    assert.ok(await page.locator('.workspace-list-area').evaluate(element => element.getAttribute('id')))
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, false)
    await page.evaluate(() => { window.disposeFolding() })
    assert.equal(await page.locator('.sidebar-root > button[aria-controls]').count(), 0)
    assert.deepEqual(await workspaceRegion(page).evaluate(element => ({ attributes: [...element.attributes].map(attribute => [attribute.name, attribute.value]).sort(), html: element.innerHTML })), original)
    assert.equal(await workspaceRegion(page).evaluate(element => getComputedStyle(element).display), 'flex')
    assert.equal(await page.locator('.workspace-tree').isVisible(), true)
  }, '?no-auto=1')
})

test('workspace state survives the whole sidebar rail and restoring its wide browser', async () => {
  await withPage(async page => {
    await expectWorkspaceExpanded(page, true)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, false)
    await page.locator('#frame').evaluate(element => element.setAttribute('data-sidebar-collapsed', 'true'))
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-dsh-folding-section="workspaces"]')
      return button && getComputedStyle(button).display === 'none'
    })
    await workspaceRegion(page).evaluate(element => {
      element.innerHTML = '<div class="workspace-browser"><div class="workspace-header"><button type="button" aria-label="添加工作区">＋</button><div class="workspace-search"><button type="button" aria-label="搜索会话">⌕</button></div></div><div class="workspace-list-area"><div class="workspace-tree" role="tree" aria-label="会话"></div></div></div>'
    })
    assert.equal(await (await workspaceToggle(page)).isVisible(), false)
    await workspaceRegion(page).evaluate((element, markup) => { element.outerHTML = markup }, workspace())
    await page.locator('#frame').evaluate(element => element.removeAttribute('data-sidebar-collapsed'))
    await expectWorkspaceExpanded(page, false)
    assert.equal(await (await workspaceToggle(page)).isVisible(), true)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, true)
    await expectExpanded(page, false)
  })
})

test('recognizes English workspaces and the flat Sessions view independently of global panels', async () => {
  for (const flat of [false, true]) {
    await withPage(async page => {
      await page.evaluate(() => {
        document.documentElement.lang = 'en'
        document.querySelector('.new-session').setAttribute('aria-label', 'New session')
      })
      await workspaceRegion(page).evaluate((element, markup) => { element.outerHTML = markup }, workspace({ english: true, flat }))
      await page.evaluate(() => { window.disposeFolding = window.installFolding() })
      await expectWorkspaceExpanded(page, true)
      assert.match(await (await workspaceToggle(page)).getAttribute('title'), /workspaces/i)
      await (await workspaceToggle(page)).click()
      await expectWorkspaceExpanded(page, false)
      assert.equal(await page.locator('.workspace-header').isVisible(), true)
      assert.equal(await page.getByRole('tree', { name: 'Sessions', exact: true }).isVisible(), false)
      await (await workspaceToggle(page)).click()
      await expectWorkspaceExpanded(page, true)
      assert.equal(await page.getByRole('tree', { name: 'Sessions', exact: true }).isVisible(), true)
    }, '?empty=1&no-auto=1')
  }
})

test('a cross-tab workspace fold moves focus to its own control and removes sessions from Tab order', async () => {
  await withPage(async page => {
    await expectWorkspaceExpanded(page, true)
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, false)
    const collapsedStorage = await page.evaluate(() => Object.entries(localStorage))
    assert.ok(collapsedStorage.some(([key]) => key !== 'dsh-folding-windows:collapsed:v1'), 'workspace must persist an independent state')
    await (await workspaceToggle(page)).click()
    await expectWorkspaceExpanded(page, true)
    const writer = await page.context().newPage()
    await writer.goto(preview.url + '?no-auto=1')
    await page.bringToFront()
    await page.locator('[data-session="today"]').focus()
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-session')), 'today')
    await writer.evaluate(entries => {
      for (const [key, value] of entries) localStorage.setItem(key, value)
    }, collapsedStorage)
    await expectWorkspaceExpanded(page, false)
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-dsh-folding-section')), 'workspaces')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement.closest('.workspace-list-area') !== null), false)
    await expectExpanded(page, false)
    await writer.close()
  })
})
