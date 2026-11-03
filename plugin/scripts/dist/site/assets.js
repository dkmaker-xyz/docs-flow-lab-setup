/** The viewer's only stylesheet and script, served by the local server (no external fonts, CDNs or scripts). */
export const SITE_CSS = `:root{color-scheme:light dark;--fg:#1d1f23;--muted:#5d636e;--bg:#fff;--line:#d9dde3;--side:#f5f6f8;--link:#0b57d0;--note:#fff4ce;--warn:#fde7e9;--warn-line:#c4314b}
@media (prefers-color-scheme:dark){:root{--fg:#e6e8eb;--muted:#a3a9b3;--bg:#16181c;--line:#30343b;--side:#1d2025;--link:#8ab4f8;--note:#3d3418;--warn:#3d1f24;--warn-line:#f28b9a}}
*{box-sizing:border-box}html{font-size:16px}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);line-height:1.5}
a{color:var(--link)}
.top{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;padding:.6rem 1rem;border-bottom:1px solid var(--line)}
.home{font-weight:600;text-decoration:none;color:var(--fg);margin-right:auto}
.search{display:flex;gap:.3rem}.search input{width:18rem;max-width:50vw}
input,select,button{font:inherit;padding:.25rem .5rem;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)}
.tabs{display:flex;flex-wrap:wrap;gap:.2rem;padding:0 1rem;border-bottom:1px solid var(--line)}
.tabs a{padding:.45rem .8rem;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a.active{color:var(--fg);font-weight:600;border-bottom-color:var(--link)}
.results .type{display:inline-block;min-width:6.5rem;color:var(--muted);font-size:.85rem}
.wrap{display:flex;align-items:flex-start}
.side{width:18rem;flex:none;padding:1rem;background:var(--side);border-right:1px solid var(--line);min-height:calc(100vh - 3rem);font-size:.9rem}
.side h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:1rem 0 .3rem}
.side ul{list-style:none;margin:0;padding:0}.side li{margin:.15rem 0}.side a{text-decoration:none}.side li.current a{font-weight:600;color:var(--fg)}
.side .empty{margin:0;color:var(--muted)}
main{flex:1;padding:1.5rem 2rem;min-width:0}
main > *{max-width:70ch}
.note{background:var(--note);padding:.3rem .6rem;border-radius:4px;font-size:.9rem}
.meta{color:var(--muted);font-size:.9rem;margin:0}.id{font-variant-numeric:tabular-nums;font-weight:600}
h1{font-size:1.6rem;line-height:1.25;margin:.3rem 0 .6rem}
.badge{display:inline-block;padding:0 .45rem;border-radius:999px;font-size:.8rem;border:1px solid var(--line)}
.s-accepted,.s-released{background:#d5f0dd;color:#14532d;border-color:#9fd7b0}.s-proposed,.s-development,.s-planned{background:#dbe8ff;color:#1e3a8a;border-color:#a9c3f5}
.s-draft{background:#eceef1;color:#374151}.s-deprecated{background:#fff1c2;color:#713f12;border-color:#ecd27a}.s-superseded,.s-retired{background:#fde2e1;color:#7f1d1d;border-color:#f3a7a3}
.banner{background:var(--warn);border-left:4px solid var(--warn-line);padding:.4rem .8rem;margin:.6rem 0;border-radius:2px}.banner p{margin:.2rem 0}
.intent{font-size:1.05rem;color:var(--muted);margin:.2rem 0 1rem}
.toc{border:1px solid var(--line);border-radius:4px;padding:.4rem .8rem;margin:0 0 1rem;font-size:.9rem}.toc-title{margin:0;font-weight:600}.toc ul{margin:.2rem 0;padding-left:1.1rem}.toc .d3{margin-left:1rem}
.body{max-width:70ch;line-height:1.5}.body pre{overflow:auto;padding:.6rem;background:var(--side);border-radius:4px}.body code{font-size:.9em}.body table{border-collapse:collapse}.body td,.body th{border:1px solid var(--line);padding:.2rem .5rem}.body img{max-width:100%}
.relations{border-top:1px solid var(--line);margin-top:1.5rem}.relations h2{font-size:1.1rem}.relations h3{font-size:.95rem;margin:.6rem 0 .2rem}.relations ul{padding-left:1.1rem}.relations li{margin:.35rem 0}
.rtype{color:var(--muted);font-size:.9rem}.why{display:block;color:var(--muted);font-size:.9rem}
.recent{border-collapse:collapse;width:100%;max-width:70rem}.recent th,.recent td{text-align:left;padding:.3rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
main > .recent{max-width:70rem}
.results{padding-left:1.1rem}.results li{margin:.35rem 0}.count,.intro{color:var(--muted)}
@media (max-width:800px){.wrap{flex-direction:column}.side{width:100%;min-height:0;border-right:0;border-bottom:1px solid var(--line)}main{padding:1rem}}
`;
/** Switches the version as soon as one is picked (the form also works without script). */
export const SITE_JS = `document.addEventListener("DOMContentLoaded",function(){var s=document.getElementById("v");if(s){s.addEventListener("change",function(){s.form.submit();});}});
`;
