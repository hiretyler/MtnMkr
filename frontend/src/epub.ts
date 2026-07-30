import { strToU8, zipSync } from 'fflate'
import {
  composeStandalone,
  downloadBlob,
  exportSlug,
  type StandaloneExportOpts,
} from './export'

// iOS Quick Look renders AirDropped .html with scripts off, but Apple
// Books runs scripted EPUB3 - so the same standalone viewer packaged as
// .epub opens interactive on an iPhone with no extra app. Verified on
// device: Books executes external scripts, WebGL, and multi-MB payloads.

// Fixed-layout viewport; Books scales the page to the screen
const PAGE_W = 1170
const PAGE_H = 2080

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function displayOptionsXml(): string {
  // Apple-specific: declares the book interactive so Books enables full
  // scripted behavior
  return `<?xml version="1.0" encoding="UTF-8"?>
<display_options>
  <platform name="*">
    <option name="interactive">true</option>
  </platform>
</display_options>
`
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
}

function contentOpf(title: string, modified: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${crypto.randomUUID()}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">none</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="page" href="page.xhtml" media-type="application/xhtml+xml" properties="scripted"/>
    <item id="payload" href="payload.js" media-type="application/javascript"/>
    <item id="viewer" href="viewer.js" media-type="application/javascript"/>
  </manifest>
  <spine>
    <itemref idref="page"/>
  </spine>
</package>
`
}

function navXhtml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${escapeXml(title)}</title></head>
  <body>
    <nav epub:type="toc">
      <ol><li><a href="page.xhtml">${escapeXml(title)}</a></li></ol>
    </nav>
  </body>
</html>
`
}

function pageXhtml(title: string): string {
  // Well-formed XHTML: scripts stay external so their content is never
  // XML-parsed; the boot style contains no & or <
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=${PAGE_W}, height=${PAGE_H}, user-scalable=no"/>
    <title>${escapeXml(title)}</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        overscroll-behavior: none;
        touch-action: none;
        -webkit-user-select: none;
      }
      #app {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ede8dc;
        color: #2a2118;
        font-family: system-ui, sans-serif;
        font-size: 32px;
      }
    </style>
  </head>
  <body>
    <div id="app"><div class="boot">Loading terrain…</div></div>
    <script src="payload.js"></script>
    <script src="viewer.js"></script>
  </body>
</html>
`
}

export async function exportStandaloneEpub(opts: StandaloneExportOpts): Promise<void> {
  const { payload, bundle } = await composeStandalone(opts)
  const title = payload.center.name ?? 'MtnMkr terrain'
  // dcterms:modified wants whole seconds
  const modified = payload.generated.replace(/\.\d+Z$/, 'Z')

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    // OCF: mimetype must be the first entry and stored uncompressed
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(containerXml()),
    'META-INF/com.apple.ibooks.display-options.xml': strToU8(displayOptionsXml()),
    'OEBPS/content.opf': strToU8(contentOpf(title, modified)),
    'OEBPS/nav.xhtml': strToU8(navXhtml(title)),
    'OEBPS/page.xhtml': strToU8(pageXhtml(title)),
    // JSON.stringify output is a valid JS object literal
    'OEBPS/payload.js': strToU8(`window.mtnmkrPayload = ${JSON.stringify(payload)}\n`),
    'OEBPS/viewer.js': strToU8(bundle),
  }
  const zipped = zipSync(files, { level: 6 })

  downloadBlob(
    new Blob([zipped as unknown as BlobPart], { type: 'application/epub+zip' }),
    `${exportSlug(payload.center.name)}.epub`,
  )
}
