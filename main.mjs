import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
})
const [page] = await browser.pages()
const userAgent = await browser.userAgent()
await page.setUserAgent(userAgent.replace('Headless', ''))
const recorder = await page.screencast({ path: 'recording.webm' })

async function solveTurnstileWithYesCaptcha(currentPage) {
    const clientKey = process.env.YESCAPTCHA_CLIENT_KEY
    if (!clientKey) {
        console.warn('YESCAPTCHA_CLIENT_KEY is not set, skipping Turnstile solving')
        return null
    }

    const siteKey = await currentPage.$eval('.cf-turnstile', el => el.getAttribute('data-sitekey') || el.dataset.sitekey).catch(() => null)
    if (!siteKey) {
        console.warn('Turnstile sitekey not found on page, skipping Turnstile solving')
        return null
    }

    const ua = await currentPage.evaluate(() => navigator.userAgent)
    const createPayload = {
        clientKey,
        task: {
            type: 'TurnstileTaskProxyless',
            websiteURL: currentPage.url(),
            websiteKey: siteKey,
            userAgent: ua,
        },
    }

    const createResp = await fetch('https://api.yescaptcha.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPayload),
    })
    const createData = await createResp.json()
    if (createData.errorId) {
        throw new Error(`YesCaptcha createTask error: ${createData.errorId} ${createData.errorDescription ?? ''}`)
    }

    for (let attempt = 0; attempt < 20; attempt++) {
        await setTimeout(3000)
        const resultResp = await fetch('https://api.yescaptcha.com/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey, taskId: createData.taskId }),
        })
        const resultData = await resultResp.json()
        if (resultData.errorId) {
            throw new Error(`YesCaptcha getTaskResult error: ${resultData.errorId} ${resultData.errorDescription ?? ''}`)
        }
        if (resultData.status === 'ready') {
            return resultData.solution?.token ?? null
        }
    }

    throw new Error('YesCaptcha Turnstile solving timed out')
}

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    const turnstileToken = await solveTurnstileWithYesCaptcha(page)
    if (turnstileToken) {
        console.log('YesCaptcha solved Turnstile, injecting token')
        await page.$eval('[name="cf-turnstile-response"]', (el, token) => {
            el.value = token
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
        }, turnstileToken).catch(() => console.warn('Turnstile response field not found for token injection'))
    }
    await page.locator('text=無料VPSの利用を継続する').click()
} catch (e) {
    console.error(e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
