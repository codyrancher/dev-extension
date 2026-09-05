import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// Uploads files to GitHub's user-attachments CDN through the browser sidecar's
// authenticated session.
//
// The CSRF token for /upload/policies/assets is NOT the generic
// input[name="authenticity_token"] (those are scoped per-form and the endpoint
// rejects them with an HTML error page). It is the dedicated
// input.js-data-upload-policy-url-csrf that ships with the classic comment box.
// GitHub's new React issue UI no longer renders that element, so point this at a
// page that still uses the classic uploader, e.g. a pull request page.

const CDP = process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222'
const hostUrl = process.argv[2]
const filePaths = process.argv.slice(3)

const browser = await chromium.connectOverCDP(CDP)
const ctx = browser.contexts()[0] || await browser.newContext()
const page = await ctx.newPage()

try {
  await page.goto(hostUrl, { waitUntil: 'domcontentloaded' })
  // hidden input, so wait for attachment rather than visibility
  await page.waitForSelector('input.js-data-upload-policy-url-csrf', { state: 'attached', timeout: 30000 })

  for (const fp of filePaths) {
    const data = readFileSync(fp)
    const b64 = data.toString('base64')
    const name = basename(fp)
    // GitHub rejects the policy request when the extension and the content type disagree, so every
    // extension we upload needs an entry here.
    const CONTENT_TYPES = {
      '.webm': 'video/webm',
      '.mp4':  'video/mp4',
      '.mov':  'video/quicktime',
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif':  'image/gif',
      '.webp': 'image/webp',
    }
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    const ct = CONTENT_TYPES[ext] || 'application/octet-stream'

    const href = await page.evaluate(async({ b64, name, ct }) => {
      const token = document.querySelector('input.js-data-upload-policy-url-csrf')?.value

      if (!token) throw new Error('no js-data-upload-policy-url-csrf token on page')

      const fa = document.querySelector('file-attachment[data-upload-repository-id]')
      const repoId = fa?.getAttribute('data-upload-repository-id')
        || document.querySelector('meta[name="octolytics-dimension-repository_id"]')?.content

      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

      const polForm = new FormData()

      polForm.append('name', name)
      polForm.append('size', String(bytes.length))
      polForm.append('content_type', ct)
      polForm.append('repository_id', String(repoId))
      polForm.append('authenticity_token', token)

      const polResp = await fetch('/upload/policies/assets', {
        method:  'POST',
        headers: { Accept: 'application/json' },
        body:    polForm,
      })

      if (!polResp.ok) {
        throw new Error(`policy ${ polResp.status }: ${ (await polResp.text()).slice(0, 400) }`)
      }
      const pol = await polResp.json()

      const form = new FormData()

      for (const [k, v] of Object.entries(pol.form)) form.append(k, String(v))
      form.append('file', new Blob([bytes], { type: ct }), name)

      const upResp = await fetch(pol.upload_url, { method: 'POST', body: form, mode: 'cors' })

      if (!upResp.ok) throw new Error(`upload ${ upResp.status }: ${ (await upResp.text()).slice(0, 200) }`)

      // Tell GitHub the S3 put succeeded, otherwise the asset stays unconfirmed.
      if (pol.asset_upload_url) {
        const confirm = await fetch(pol.asset_upload_url, {
          method:  'PUT',
          headers: { Accept: 'application/json' },
          body:    (() => {
            const f = new FormData()

            f.append('authenticity_token', pol.asset_upload_authenticity_token)

            return f
          })(),
        })

        if (!confirm.ok) throw new Error(`confirm ${ confirm.status }`)
      }

      return pol.asset.href
    }, { b64, name, ct })

    console.log(`${ name }\t${ href }`)
  }
} finally {
  await page.close()
  await browser.close()
}
