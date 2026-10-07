/** Маленькие docx/xlsx/pdf для тестов чтения файлов (собираются в памяти, двоичных фикстур в репозитории нет). */
import { strToU8, zipSync } from 'fflate';

export function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`,
    )
    .join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`),
  });
}

export function makeXlsx(): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook><sheets><sheet name="Счета" sheetId="1"/><sheet name="Итог" sheetId="2"/></sheets></workbook>',
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst><si><t>Номер</t></si><si><t>Сумма</t></si><si><r><t>Сч</t></r><r><t>ёт 15</t></r></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>16320.5</v></c></row>' +
        '</sheetData></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Итого &amp; всё</t></is></c></row></sheetData></worksheet>',
    ),
  });
}

/** Минимальный PDF с одной страницей и текстом (Helvetica — только латиница). */
export function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return strToU8(out);
}
