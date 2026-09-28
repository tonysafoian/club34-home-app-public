import ExcelJS from 'exceljs';

function sheetToCsv(worksheet: ExcelJS.Worksheet): string {
  const rows: string[] = [];
  worksheet.eachRow((row) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1);
    const cells = values.map((v) => {
      if (v == null) return '';
      if (typeof v === 'object' && 'result' in v) return String((v as ExcelJS.CellFormulaValue).result ?? '');
      if (typeof v === 'object' && 'richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
      if (typeof v === 'object' && 'hyperlink' in v) return String((v as ExcelJS.CellHyperlinkValue).text ?? '');
      return String(v);
    });
    rows.push(cells.join(','));
  });
  return rows.join('\n');
}

export async function readXlsxToText(arrayBuffer: ArrayBuffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);
  const sheetTexts: string[] = [];
  workbook.eachSheet((worksheet) => {
    const csv = sheetToCsv(worksheet);
    if (csv.trim()) {
      sheetTexts.push(`### ${worksheet.name}\n${csv}`);
    }
  });
  return sheetTexts.join('\n\n').trim();
}
