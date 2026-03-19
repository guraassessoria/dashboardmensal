# build-dev.ps1 — Regenera dashboard-dev.html a partir de dashboard.html
# Encoding-safe: nenhum caracter nao-ASCII em literais de string

$src = Join-Path $PSScriptRoot "..\public\dashboard.html"
$dst = Join-Path $PSScriptRoot "..\public\dashboard-dev.html"
$utf8 = [System.Text.Encoding]::UTF8
$content = [System.IO.File]::ReadAllText($src, $utf8)

# Char helpers
$gear     = [char]0x2699 + [char]0xFE0F  # ⚙️
$emdash   = [char]0x2014                  # —
$dh       = [char]0x2550                  # ═
$minus    = [char]0x2212                  # −
$bullet   = [char]0x25CF                  # ●

# ── 1. Titulo
$content = $content.Replace(
    '<title>' + $gear + ' CBF Dashboard</title>',
    '<title>' + $gear + ' DEV ' + $emdash + ' CBF Dashboard</title>'
)

# ── 2. sticky-chrome: compensar banner fixo
$content = $content.Replace(
    '.sticky-chrome{position:sticky;top:0;z-index:200;}',
    '.sticky-chrome{position:sticky;top:30px;z-index:200;}'
)

# ── 3. Tamanhos base de header (menores no DEV)
$content = $content.Replace(
    'font-size:clamp(21px,3.1vw,35px);font-weight:700;letter-spacing:2px;color:var(--white);line-height:1}',
    'font-size:clamp(16px,2.3vw,27px);font-weight:700;letter-spacing:2px;color:var(--white);line-height:1}'
)
$content = $content.Replace(
    '.htitles p{font-size:13px;color:rgba(255,255,255,.5);margin-top:6px;font-weight:300}',
    '.htitles p{font-size:8px;color:rgba(255,255,255,.5);margin-top:6px;font-weight:300}'
)
$content = $content.Replace(
    '.yr{font-family:var(--font-heading);font-size:57px;',
    '.yr{font-family:var(--font-heading);font-size:26px;'
)
$content = $content.Replace(
    'padding:4px 12px;font-size:9px;color:var(--pos);font-weight:500;margin-top:8px}',
    'padding:4px 12px;font-size:7px;color:var(--pos);font-weight:500;margin-top:8px}'
)
$content = $content.Replace(
    ".badge::before{content:'" + $bullet + "';font-size:7px}",
    ".badge::before{content:'" + $bullet + "';font-size:5px}"
)
$content = $content.Replace(
    '.ntab{padding:11px 14px;font-size:13px;',
    '.ntab{padding:8px 11px;font-size:10px;'
)
$content = $content.Replace(
    'var(--font-mono);font-size:9px;letter-spacing:2px;color:var(--yellow);text-transform:uppercase;margin-bottom:8px}',
    'var(--font-mono);font-size:7px;letter-spacing:2px;color:var(--yellow);text-transform:uppercase;margin-bottom:8px}'
)
$content = $content.Replace(
    'font-size:clamp(24px,2.5vw,35px);font-weight:700;letter-spacing:1px;line-height:1.1;margin-bottom:32px}',
    'font-size:clamp(18px,1.9vw,27px);font-weight:700;letter-spacing:1px;line-height:1.1;margin-bottom:32px}'
)

# ── 4. Inserir bloco DEV MODE STYLES apos .kcard:hover
$devStyles = "`r`n`r`n/* " + $dh+$dh + " DEV MODE STYLES " + $dh+$dh + " */`r`n" +
    "#dev-banner{position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(90deg,#e74c3c,#c0392b);color:#fff;font:bold 12px var(--font-mono);padding:6px 16px;display:flex;justify-content:space-between;align-items:center;letter-spacing:1px}`r`n" +
    "#dev-banner button{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:8px}`r`n" +
    "#dev-banner button:hover{background:rgba(255,255,255,.35)}`r`n" +
    "body.dev-grid-on *{outline:1px solid rgba(255,0,0,.15) !important}`r`n" +
    "body.dev-grid-on .kcard,body.dev-grid-on .ccard{outline:2px solid rgba(0,200,255,.4) !important}`r`n" +
    "body{padding-top:32px}"
$content = $content.Replace(
    '.kcard:hover{transform:translateY(-2px);border-color:rgba(245,201,0,.2)}',
    '.kcard:hover{transform:translateY(-2px);border-color:rgba(245,201,0,.2)}' + $devStyles
)

# ── 5. Substituir BODY FONT SIZES (+10%) por (-20%): linha a linha
$commentOld = '/* ' + $dh+$dh + ' BODY FONT SIZES (+10%) ' + $dh+$dh + ' */'
$commentNew = '/* ' + $dh+$dh + ' BODY FONT SIZES (' + $minus + '20% again) ' + $dh+$dh + ' */'
$content = $content.Replace($commentOld, $commentNew)

$content = $content.Replace('.klabel{font-size:13px !important}', '.klabel{font-size:10px !important}')
$content = $content.Replace('.kval{font-size:clamp(29px,4vw,42px) !important}', '.kval{font-size:clamp(22px,3vw,32px) !important}')
$content = $content.Replace('.kdelta{font-size:13px !important}', '.kdelta{font-size:10px !important}')
$content = $content.Replace('.ksub{font-size:12px !important}', '.ksub{font-size:9px !important}')
$content = $content.Replace('.ctitle{font-size:18px !important}', '.ctitle{font-size:13px !important}')
$content = $content.Replace('.csub{font-size:13px !important}', '.csub{font-size:10px !important}')
$content = $content.Replace('.insight p{font-size:14px !important}', '.insight p{font-size:11px !important}')
$content = $content.Replace('.ilabel{font-size:12px !important}', '.ilabel{font-size:9px !important}')
$content = $content.Replace('table{font-size:14px !important}', 'table{font-size:11px !important}')
$content = $content.Replace('th{font-size:12px !important}', 'th{font-size:9px !important}')
$content = $content.Replace('td{font-size:13px !important}', 'td{font-size:10px !important}')
$content = $content.Replace('.slabel{font-size:12px !important}', '.slabel{font-size:9px !important}')
$content = $content.Replace('.stitle{font-size:clamp(29px,3.2vw,45px) !important}', '.stitle{font-size:clamp(22px,2.4vw,34px) !important}')
$content = $content.Replace('.pl{font-size:14px !important}', '.pl{font-size:11px !important}')
$content = $content.Replace('.pv{font-size:13px !important}', '.pv{font-size:10px !important}')
$content = $content.Replace('.tt{font-size:14px !important}', '.tt{font-size:11px !important}')
$content = $content.Replace('.tx{font-size:13px !important}', '.tx{font-size:10px !important}')
$content = $content.Replace('.td{font-size:12px !important}', '.td{font-size:9px !important}')
$content = $content.Replace('.airole{font-size:13px !important}', '.airole{font-size:10px !important}')
$content = $content.Replace('.aiuse{font-size:13px !important}', '.aiuse{font-size:10px !important}')
$content = $content.Replace('.ainame{font-size:19px !important}', '.ainame{font-size:14px !important}')
$content = $content.Replace('footer p{font-size:13px !important}', 'footer p{font-size:10px !important}')
$content = $content.Replace('.mono{font-size:12px !important}', '.mono{font-size:9px !important}')

$inlineComment = '/* Padronizar inline font-sizes (+10%) */'
$inlineCommentNew = '/* Padronizar inline font-sizes (' + $minus + '20% again) */'
$content = $content.Replace($inlineComment, $inlineCommentNew)

$content = $content.Replace('[style*="font-size:10px"]{font-size:13px !important}', '[style*="font-size:10px"]{font-size:9px !important}')
$content = $content.Replace('[style*="font-size:11px"]{font-size:14px !important}', '[style*="font-size:11px"]{font-size:9px !important}')
$content = $content.Replace('[style*="font-size:12px"]{font-size:15px !important}', '[style*="font-size:12px"]{font-size:10px !important}')
$content = $content.Replace('[style*="font-size:13px"]{font-size:18px !important}', '[style*="font-size:13px"]{font-size:11px !important}')
$content = $content.Replace('[style*="font-size:14px"]{font-size:19px !important}', '[style*="font-size:14px"]{font-size:11px !important}')
$content = $content.Replace('[style*="font-size:16px"]{font-size:21px !important}', '[style*="font-size:16px"]{font-size:14px !important}')
$content = $content.Replace('[style*="font-size:28px"]{font-size:37px !important}', '[style*="font-size:28px"]{font-size:22px !important}')
$content = $content.Replace('[style*="font-size:30px"]{font-size:40px !important}', '[style*="font-size:30px"]{font-size:25px !important}')
$content = $content.Replace('[style*="font-size:56px"]{font-size:74px !important}', '[style*="font-size:56px"]{font-size:45px !important}')
$content = $content.Replace('[style*="font-size:80px"]{font-size:106px !important}', '[style*="font-size:80px"]{font-size:64px !important}')

# ── 6. pdf-btn: fonte menor no DEV
$content = $content.Replace(
    'color:var(--yellow);font-size:15px;font-weight:600;letter-spacing:.5px;cursor:pointer;white-space:nowrap;transition:background .2s,color .2s}',
    'color:var(--yellow);font-size:12px;font-weight:600;letter-spacing:.5px;cursor:pointer;white-space:nowrap;transition:background .2s,color .2s}'
)

# ── 7. Inserir dev-banner HTML logo apos <body>
$devBanner = '<div id="dev-banner">' + "`r`n" +
    '  <span>' + [char]0xD83D + [char]0xDD27 + ' DEV MODE ' + [char]0x2014 + ' Altera' + [char]0xE7 + [char]0xF5 + 'es de layout aqui n' + [char]0xE3 + 'o afetam produ' + [char]0xE7 + [char]0xE3 + 'o</span>' + "`r`n" +
    '  <span>' + "`r`n" +
    "    <button onclick=""document.body.classList.toggle('dev-grid-on')"" title=""Mostra bordas dos elementos"">Grid Debug</button>`r`n" +
    "    <button onclick=""window.open('dashboard.html','_blank')"" title=""Abre a vers" + [char]0xE3 + "o original para comparar"">Ver Original</button>`r`n" +
    '    <button onclick="location.reload()" title="Recarregar">' + [char]0x21BB + ' Reload</button>' + "`r`n" +
    '  </span>' + "`r`n" +
    '</div>' + "`r`n`r`n"
$content = $content.Replace("`r`n<body>`r`n", "`r`n<body>`r`n" + $devBanner)

# ── 8. Salvar
[System.IO.File]::WriteAllText($dst, $content, $utf8)
Write-Host "✅ dashboard-dev.html gerado com sucesso a partir de dashboard.html"