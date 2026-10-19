'use strict';
const fs=require('fs'),path=require('path'),acorn=require('acorn'),walk=require('acorn-walk');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'renderer','i18n.js'),'utf8');
const ast=acorn.parse(source,{ecmaVersion:'latest'}),rows=[];
const add=row=>{if(row?.type!=='ArrayExpression')return;const values=row.elements.map(value=>value?.type==='Literal'?value.value:null);if(values.length===8&&values.every(value=>typeof value==='string'))rows.push(values);};
walk.simple(ast,{VariableDeclarator(node){if(node.id.name==='rows'&&node.init?.type==='ArrayExpression')node.init.elements.forEach(add);},CallExpression(node){if(node.callee?.type==='MemberExpression'&&node.callee.object?.name==='rows'&&node.callee.property?.name==='push')node.arguments.forEach(add);}});
const locales=['ja','en','zh-CN','ko','es','fr','de','pt-BR'],table={};for(const row of rows){table[row[0]]={};locales.forEach((locale,index)=>table[row[0]][locale]=index?row[index]:row[0]);}
const output=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'renderer','i18n-data.json');fs.writeFileSync(output,JSON.stringify(table,null,2)+'\n','utf8');
console.log(`Wrote ${Object.keys(table).length} translated messages.`);
