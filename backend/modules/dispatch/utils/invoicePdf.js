'use strict';

function safe(value,limit=80){return String(value??'—').normalize('NFKD').replace(/[^\x20-\x7E]/g,'').replace(/[\\()]/g,'\\$&').slice(0,limit);}
function money(value){return `INR ${Number(value||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
const columns=[
 {label:'Product / description',width:156,value:line=>line.description},
 {label:'Roll',width:62,value:line=>line.roll_no},
 {label:'Qty (m)',width:54,value:line=>Number(line.quantity_m||0).toLocaleString('en-IN',{maximumFractionDigits:2})},
 {label:'Rate / m',width:78,value:line=>money(line.rate_per_m)},
 {label:'Tax %',width:48,value:line=>`${Number(line.tax_percent||0)}%`},
 {label:'Subtotal',width:88,value:line=>money(line.line_subtotal)},
 {label:'Tax amount',width:82,value:line=>money(line.line_tax)},
 {label:'Line total',width:92,value:line=>money(line.line_total)},
];
const x0=36,rowHeight=19;
function text(commands,x,y,value,size=8,bold=false){commands.push('BT',`/${bold?'F2':'F1'} ${size} Tf`,`1 0 0 1 ${x} ${y} Tm`,`(${safe(value)}) Tj`,'ET');}
function line(commands,x1,y1,x2,y2){commands.push('0.78 G 0.6 w',`${x1} ${y1} m ${x2} ${y2} l S`,'0 G');}
function table(commands,rows,top){
 const width=columns.reduce((sum,column)=>sum+column.width,0);let x=x0;const headerBottom=top-rowHeight;
 commands.push('0.93 g',`${x0} ${headerBottom} ${width} ${rowHeight} re f`,'0 G');
 columns.forEach(column=>{text(commands,x+5,top-13,column.label,7,true);x+=column.width;});
 line(commands,x0,headerBottom,x0+width,headerBottom);
 let y=headerBottom;
 rows.forEach(row=>{x=x0;const bottom=y-rowHeight;line(commands,x0,bottom,x0+width,bottom);columns.forEach(column=>{const maxChars=Math.max(6,Math.floor((column.width-10)/4));text(commands,x+5,bottom+6,String(column.value(row)??'—').slice(0,maxChars),7,false);x+=column.width;});y=bottom;});
 x=x0;commands.push('0.78 G 0.6 w');columns.forEach(column=>{commands.push(`${x} ${top} m ${x} ${y} l S`);x+=column.width;});commands.push(`${x} ${top} m ${x} ${y} l S`,'0 G');line(commands,x0,top,x0+width,top);return y;
}
function createInvoicePdf(invoice){
 const lines=invoice.lines||[];const pageSize=16;const groups=[];for(let i=0;i<lines.length;i+=pageSize)groups.push(lines.slice(i,i+pageSize));if(!groups.length)groups.push([]);
 const objects=[];const add=value=>{objects.push(value);return objects.length;};const catalogId=add('');const pagesId=add('');const fontId=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');const boldFontId=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');const pageIds=[];
 groups.forEach((pageRows,pageIndex)=>{
  const commands=[];text(commands,x0,574,invoice.invoice_status==='VOID'?'VOID TAX INVOICE':invoice.invoice_status==='DRAFT'?'DRAFT INVOICE':'TAX INVOICE',17,true);
  if(pageIndex===0){
   text(commands,x0,550,`Invoice: ${invoice.invoice_no}     Status: ${invoice.invoice_status}`,9,true);
   text(commands,x0,533,`Invoice date: ${String(invoice.invoice_date||'').slice(0,10)||'—'}     Due date: ${String(invoice.due_date||'').slice(0,10)||'Not specified'}`,8);
   text(commands,x0,516,`Order: ${invoice.order_no}     Shipment: ${invoice.shipment_no}`,8);
   text(commands,x0,499,`Bill to: ${invoice.company_name} (${invoice.buyer_code})`,8);
   const address=[invoice.billing_line1,invoice.billing_city,invoice.billing_state,invoice.billing_pincode,invoice.billing_country].filter(Boolean).join(', ');
   text(commands,x0,482,`Billing address: ${address||'Not on file'}`,8);
  }else text(commands,x0,550,`Invoice ${invoice.invoice_no} - continued`,9,true);
  const tableTop=pageIndex===0?461:523;const bottom=table(commands,pageRows,tableTop);
  if(pageIndex===groups.length-1){
   const totalsTop=Math.min(bottom-20,118);text(commands,512,totalsTop,'Subtotal',8);text(commands,644,totalsTop,money(invoice.subtotal),8,true);
   text(commands,512,totalsTop-14,'Tax',8);text(commands,644,totalsTop-14,money(invoice.tax_amount),8,true);
   text(commands,512,totalsTop-28,'Invoice total',9,true);text(commands,644,totalsTop-28,money(invoice.total_amount),9,true);
   text(commands,512,totalsTop-44,'Net paid',8);text(commands,644,totalsTop-44,money(invoice.net_paid),8,true);
   text(commands,512,totalsTop-58,'Balance due',9,true);text(commands,644,totalsTop-58,money(invoice.balance_due),9,true);
   text(commands,x0,totalsTop-78,`Payment status: ${invoice.payment_status}     Shipment status: ${invoice.shipment_status}`,8,true);
   text(commands,x0,totalsTop-92,`Carrier: ${invoice.carrier_name||'—'}     Vehicle: ${invoice.vehicle_number||'—'}     Tracking: ${invoice.tracking_number||'—'}`,7);
   text(commands,x0,totalsTop-105,`Delivery note: ${invoice.delivery_note_no||'—'}     Texora customer invoice.`,7);
  }
  text(commands,730,20,`${pageIndex+1} / ${groups.length}`,8);
  const stream=commands.join('\n');const contentId=add(`<< /Length ${Buffer.byteLength(stream,'ascii')} >>\nstream\n${stream}\nendstream`);
  pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
 });
 objects[catalogId-1]=`<< /Type /Catalog /Pages ${pagesId} 0 R >>`;objects[pagesId-1]=`<< /Type /Pages /Kids [${pageIds.map(value=>`${value} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
 let pdf='%PDF-1.4\n%Texora invoice\n';const offsets=[0];objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf,'ascii'));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});const xref=Buffer.byteLength(pdf,'ascii');pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return Buffer.from(pdf,'ascii');
}
module.exports={createInvoicePdf};
