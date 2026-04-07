/**
 * Kody ADE — Demo Video Recorder
 *
 * Records a ~70s walkthrough of a real Kody pipeline run:
 *   Issue #530 → @kody comment → pipeline stages → PR #531 → code diff
 *
 * Usage: npx tsx demo/record.ts
 * Output: demo/videos/kody-demo.webm
 *
 * After recording, convert: ffmpeg -i demo/videos/kody-demo.webm -c:v libx264 -crf 20 demo/videos/kody-demo.mp4
 */

import { chromium, type Page, type BrowserContext } from 'playwright'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Config ──────────────────────────────────────────────────────────
const ISSUE_URL = 'https://github.com/aharonyaircohen/Kody-Engine-Tester/issues/530'
const PR_URL = 'https://github.com/aharonyaircohen/Kody-Engine-Tester/pull/531'
const PR_FILES_URL = `${PR_URL}/files`
const VIDEO_DIR = path.join(__dirname, 'videos')
const VIEWPORT = { width: 1280, height: 800 }

// ── Helpers ─────────────────────────────────────────────────────────

async function wait(page: Page, ms: number) {
  await page.waitForTimeout(ms)
}

async function smoothScroll(page: Page, deltaY: number, steps = 5) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY / steps)
    await wait(page, 100)
  }
}

async function scrollToText(page: Page, text: string) {
  const el = await page.locator(`text="${text}"`).first()
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 3000 })
  } catch {
    await smoothScroll(page, 400)
  }
}

async function overlay(page: Page, text: string, durationMs: number, position: 'top' | 'bottom' = 'top') {
  await page.evaluate(
    ({ text, position }) => {
      document.getElementById('kody-overlay')?.remove()

      const el = document.createElement('div')
      el.id = 'kody-overlay'
      el.innerHTML = text
      Object.assign(el.style, {
        position: 'fixed',
        top: position === 'top' ? '24px' : 'auto',
        bottom: position === 'bottom' ? '24px' : 'auto',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '99999',
        background: 'rgba(0, 0, 0, 0.88)',
        color: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        fontSize: '18px',
        fontWeight: '600',
        padding: '12px 24px',
        borderRadius: '10px',
        whiteSpace: 'nowrap',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.12)',
        opacity: '0',
        transition: 'opacity 0.3s ease',
      })
      document.body.appendChild(el)
      requestAnimationFrame(() => { el.style.opacity = '1' })
    },
    { text, position }
  )
  await wait(page, durationMs)
  await page.evaluate(() => {
    const el = document.getElementById('kody-overlay')
    if (el) {
      el.style.opacity = '0'
      setTimeout(() => el.remove(), 300)
    }
  })
  await wait(page, 350)
}

async function fullCard(page: Page, html: string, durationMs: number) {
  await page.evaluate((html) => {
    document.body.innerHTML = ''
    Object.assign(document.body.style, {
      margin: '0', padding: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh',
      background: 'linear-gradient(135deg, #0d1117 0%, #161b22 50%, #0d1117 100%)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    })
    const card = document.createElement('div')
    card.style.cssText = 'text-align: center; opacity: 0; transition: opacity 0.5s ease;'
    card.innerHTML = html
    document.body.appendChild(card)
    requestAnimationFrame(() => { card.style.opacity = '1' })
  }, html)
  await wait(page, durationMs)
}

// ── Scenes ──────────────────────────────────────────────────────────

async function titleCard(page: Page) {
  await fullCard(page, `
    <div style="font-size: 52px; font-weight: 800; color: #fff; letter-spacing: -1px;">
      Kody ADE
    </div>
    <div style="font-size: 20px; color: #8b949e; margin-top: 10px;">
      Autonomous Development Engine
    </div>
    <div style="font-size: 16px; color: #58a6ff; margin-top: 20px;">
      Comment on an issue &rarr; Get back a tested, reviewed PR
    </div>
  `, 3500)
}

async function issuePage(page: Page) {
  await page.goto(ISSUE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await wait(page, 2500)

  // Show issue title area
  await overlay(page, 'Start with a GitHub issue', 2200)

  // Scroll to @kody comment
  await scrollToText(page, '@kody')
  await wait(page, 600)
  await overlay(page, 'Comment @kody to trigger the pipeline', 2200)

  // Scroll to pipeline started comment
  await smoothScroll(page, 350)
  await wait(page, 800)
  await overlay(page, 'Pipeline starts automatically', 1800)

  // Scroll to complexity detection
  await smoothScroll(page, 300)
  await wait(page, 800)
  await overlay(page, 'Detects complexity — adapts the pipeline', 2000)

  // Scroll to PR created notification
  await smoothScroll(page, 300)
  await wait(page, 600)
  await overlay(page, 'Code built, tested, verified — PR created', 2200)

  // Scroll to pipeline summary table
  await smoothScroll(page, 400)
  await wait(page, 800)
  await overlay(page, 'Full pipeline summary with every stage', 2500)
}

async function prPage(page: Page) {
  await page.goto(PR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await wait(page, 2500)
  await overlay(page, 'The resulting Pull Request', 2500)

  // Scroll to show description
  await smoothScroll(page, 250)
  await wait(page, 1500)
}

async function prFilesPage(page: Page) {
  await page.goto(PR_FILES_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await wait(page, 2500)
  await overlay(page, 'Real code with tests — not just vibes', 2500)

  // Scroll through diff
  await smoothScroll(page, 350)
  await wait(page, 1500)
  await smoothScroll(page, 400)
  await wait(page, 1500)
  await smoothScroll(page, 400)
  await wait(page, 2000)
}

async function endCard(page: Page) {
  await page.goto('about:blank')
  await fullCard(page, `
    <div style="font-size: 44px; font-weight: 800; color: #fff;">
      Issue &rarr; Tested PR
    </div>
    <div style="font-size: 18px; color: #8b949e; margin-top: 14px;">
      Zero babysitting. Quality gates at every stage.
    </div>
    <div style="margin-top: 32px;">
      <code style="font-size: 16px; color: #58a6ff; background: rgba(88,166,255,0.1); padding: 10px 20px; border-radius: 8px; border: 1px solid rgba(88,166,255,0.25);">
        npm install -g @kody-ade/engine
      </code>
    </div>
    <div style="font-size: 15px; color: #6e7681; margin-top: 20px;">
      github.com/aharonyaircohen/Kody-ADE-Engine
    </div>
  `, 4000)
}

// ── Main ────────────────────────────────────────────────────────────

async function record() {
  console.log('Recording Kody ADE demo...\n')

  const browser = await chromium.launch({ headless: false })
  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
    colorScheme: 'dark',
  })

  const page = await context.newPage()

  try {
    await titleCard(page)
    await issuePage(page)
    await prPage(page)
    await prFilesPage(page)
    await endCard(page)
  } finally {
    await page.close()
    await context.close()
    await browser.close()
  }

  // Rename the output file
  const files = fs.readdirSync(VIDEO_DIR).filter(f => f.endsWith('.webm'))
  const latest = files.sort((a, b) => {
    const statA = fs.statSync(path.join(VIDEO_DIR, a))
    const statB = fs.statSync(path.join(VIDEO_DIR, b))
    return statB.mtimeMs - statA.mtimeMs
  })[0]

  if (latest && latest !== 'kody-demo.webm') {
    const src = path.join(VIDEO_DIR, latest)
    const dst = path.join(VIDEO_DIR, 'kody-demo.webm')
    fs.renameSync(src, dst)
    console.log(`\nSaved: ${dst}`)
  }

  console.log('\nConvert + speed up:')
  console.log('  ffmpeg -i demo/videos/kody-demo.webm -c:v libx264 -crf 20 -preset medium demo/videos/kody-demo.mp4 -y')
  console.log('  ffmpeg -i demo/videos/kody-demo.mp4 -filter:v "setpts=PTS/2.5" -af "atempo=2.5" -c:v libx264 -crf 20 -preset medium demo/videos/kody-demo-fast.mp4 -y')
  console.log('\nCopy to docs:')
  console.log('  cp demo/videos/kody-demo-fast.mp4 docs/assets/')
}

record().catch((err) => {
  console.error('Recording failed:', err)
  process.exit(1)
})
