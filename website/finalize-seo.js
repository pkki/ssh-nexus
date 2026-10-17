#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const input=process.argv[2];if(!input||!/^https?:\/\//.test(input))throw new Error('Usage: node finalize-seo.js https://example.com/');
const base=input.replace(/\/+$/,'')+'/',root=__dirname;
const routes={'index.html':'','en/index.html':'en/','zh-cn/index.html':'zh-cn/','ko/index.html':'ko/','es/index.html':'es/','fr/index.html':'fr/','de/index.html':'de/','pt-br/index.html':'pt-br/'};
const escapeXml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
for(const [file,route] of Object.entries(routes)){const full=path.join(root,file),url=new URL(route,base).toString();let text=fs.readFileSync(full,'utf8');text=text.replace(/<link rel="canonical" href="[^"]*">/,`<link rel="canonical" href="${url}">`);if(/property="og:url"/.test(text))text=text.replace(/<meta property="og:url" content="[^"]*">/,`<meta property="og:url" content="${url}">`);else text=text.replace('<meta property="og:type" content="website">',`<meta property="og:type" content="website"><meta property="og:url" content="${url}">`);fs.writeFileSync(full,text);}
const day=new Date().toISOString().slice(0,10),items=Object.values(routes).map(route=>{const url=new URL(route,base).toString();return `<url><loc>${escapeXml(url)}</loc><lastmod>${day}</lastmod><changefreq>weekly</changefreq><priority>${route?'0.8':'1.0'}</priority></url>`}).join('');
fs.writeFileSync(path.join(root,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>\n`);
fs.writeFileSync(path.join(root,'robots.txt'),`User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap.xml',base)}\n`);
console.log('SEO URLs finalized for',base);
