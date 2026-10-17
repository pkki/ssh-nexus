#!/usr/bin/env python3
"""Set absolute canonical/OG URLs and generate sitemap.xml after a domain is chosen."""
from pathlib import Path
from datetime import date
from urllib.parse import urljoin
import re, sys, html

if len(sys.argv) != 2 or not sys.argv[1].startswith(('https://','http://')):
    raise SystemExit('Usage: python3 finalize_seo.py https://example.com/')
base=sys.argv[1].rstrip('/')+'/'
root=Path(__file__).parent
routes={'index.html':'','en/index.html':'en/','zh-cn/index.html':'zh-cn/','ko/index.html':'ko/','es/index.html':'es/','fr/index.html':'fr/','de/index.html':'de/','pt-br/index.html':'pt-br/'}
for file,route in routes.items():
    p=root/file;s=p.read_text(encoding='utf-8');url=urljoin(base,route)
    s=re.sub(r'<link rel="canonical" href="[^"]*">',f'<link rel="canonical" href="{html.escape(url)}">',s,1)
    if 'property="og:url"' in s:
        s=re.sub(r'<meta property="og:url" content="[^"]*">',f'<meta property="og:url" content="{html.escape(url)}">',s,1)
    else:
        s=s.replace('<meta property="og:type" content="website">',f'<meta property="og:type" content="website"><meta property="og:url" content="{html.escape(url)}">',1)
    p.write_text(s,encoding='utf-8')
last=date.today().isoformat()
items=''.join(f'<url><loc>{html.escape(urljoin(base,r))}</loc><lastmod>{last}</lastmod><changefreq>weekly</changefreq><priority>{"1.0" if not r else "0.8"}</priority></url>' for r in routes.values())
(root/'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+items+'</urlset>\n',encoding='utf-8')
(root/'robots.txt').write_text(f'User-agent: *\nAllow: /\n\nSitemap: {urljoin(base,"sitemap.xml")}\n',encoding='utf-8')
print('SEO URLs finalized for',base)
