/*
 * Parser mutasi rekening BCA (e-statement PDF) > baris transaksi > Excel.
 * Semua proses berjalan lokal (di browser). Tidak ada data yang dikirim ke server.
 *
 * Dipakai di browser (window.BCAParser) dan di Node (module.exports) untuk pengujian.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------
  // 1. Ambil teks dari PDF per halaman, dengan tata letak dipertahankan
  // ---------------------------------------------------------------

  // pdfDoc: objek dokumen dari pdf.js. Hasil: array string (satu per halaman).
  async function pagesFromPdf(pdfDoc, onProgress) {
    const pages = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(layoutText(tc.items));
      if (onProgress) onProgress(p, pdfDoc.numPages);
    }
    return pages;
  }

  function median(arr) {
    if (!arr.length) return 4.8;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // Susun item teks jadi baris, dengan spasi sesuai jarak antar kolom.
  function layoutText(items) {
    const its = items
      .filter((i) => typeof i.str === 'string' && i.str.trim() !== '')
      .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width }));
    if (!its.length) return '';

    const charW = median(its.filter((i) => i.s.length >= 4).map((i) => i.w / i.s.length)) || 4.8;

    // kelompokkan per baris (y berdekatan)
    its.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of its) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= 2.5) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }

    return lines
      .map((ln) => {
        ln.items.sort((a, b) => a.x - b.x);
        let out = '';
        let prevEnd = null;
        for (const it of ln.items) {
          if (prevEnd !== null) {
            const gap = it.x - prevEnd;
            // jarak kurang dari 2,5 karakter dianggap satu spasi biasa (dobel spasi di sumber
            // PDF tetap satu spasi di hasil); jarak lebih besar dianggap pemisah kolom
            const r = gap / charW;
            const n = r <= 0.3 ? 0 : r < 2.5 ? 1 : Math.round(r);
            if (n > 0) out += ' '.repeat(n);
          }
          out += it.s;
          prevEnd = it.x + it.w;
        }
        return out;
      })
      .join('\n');
  }

  // ---------------------------------------------------------------
  // 2. Parse teks menjadi transaksi mentah
  // ---------------------------------------------------------------

  const START_RE = /^\s*(\d{2}\/\d{2})\s{2,}(\S.*)$/;
  const AMT_RE = /^(.*?)\s{2,}([\d,]+\.\d\d)(\s+DB)?(?:\s{2,}([\d,]+\.\d\d))?\s*$/;

  function num(s) {
    return parseFloat(String(s).replace(/,/g, ''));
  }

  function parseStatement(pageTexts) {
    const tx = [];
    const foot = {};
    let periode = null;
    let noRek = null;
    let cur = null;

    for (const text of pageTexts) {
      let on = false;
      const pm = text.match(/PERIODE\s*:\s*([A-Z]+\s+\d{4})/);
      if (pm && !periode) periode = pm[1];
      const rm = text.match(/NO\.\s*REKENING\s*:\s*(\d+)/);
      if (rm && !noRek) noRek = rm[1];

      for (const ln of text.split('\n')) {
        if (/TANGGAL\s+KETERANGAN\s+CBG/.test(ln)) {
          on = true;
          continue;
        }
        if (!on) continue;
        if (ln.includes('Bersambung')) break;

        let m = ln.match(/^\s*SALDO AWAL\s+:\s+([\d,]+\.\d\d)/);
        if (m) {
          foot.awal = num(m[1]);
          cur = null;
          continue;
        }
        m = ln.match(/^\s*(MUTASI CR|MUTASI DB|SALDO AKHIR)\s+:\s+([\d,]+\.\d\d)\s*(\d+)?/);
        if (m) {
          foot[m[1]] = { nilai: num(m[2]), jumlah: m[3] ? parseInt(m[3], 10) : null };
          cur = null;
          continue;
        }
        if (!ln.trim()) continue;

        const s = ln.match(START_RE);
        if (s) {
          const date = s[1];
          const rest = s[2];
          if (rest.trim().startsWith('SALDO AWAL')) {
            const sm = rest.match(/([\d,]+\.\d\d)\s*$/);
            if (sm && foot.awal === undefined) foot.awalBaris = num(sm[1]);
            cur = null;
            continue;
          }
          const a = rest.match(AMT_RE);
          if (!a) {
            // baris berawalan tanggal tapi tanpa nominal: anggap lanjutan keterangan
            if (cur) cur.extra.push(ln.trim());
            continue;
          }
          cur = {
            date: date,
            parts: a[1].trim().split(/\s{2,}/),
            amt: a[2],
            tipe: a[3] ? 'DB' : 'CR',
            saldo: a[4] || null,
            tgl: null,
            extra: [],
          };
          tx.push(cur);
        } else if (cur) {
          const t = ln.trim();
          const tm = t.match(/^TANGGAL\s*:\s*(\d{2}\/\d{2})\s*(.*)$/);
          if (tm) {
            cur.tgl = tm[1];
            if (tm[2].trim()) cur.extra.push(tm[2].trim());
          } else {
            cur.extra.push(t);
          }
        }
      }
    }
    if (foot.awal === undefined && foot.awalBaris !== undefined) foot.awal = foot.awalBaris;
    return { periode: periode, noRek: noRek, tx: tx, foot: foot };
  }

  // ---------------------------------------------------------------
  // 3. Bersihkan keterangan dan bentuk baris akhir
  // ---------------------------------------------------------------

  const DROP = [
    /^\d{2}\/\d{2}\s*\/\S+$/, //          31/03 /95031/00000
    /^\d{4}\/FT\w+\/WS\d+$/, //           0104/FTSCY/WS95011
    /^TRANSFER$/,
    /^DR( \d+)?$/,
    /^BCA\d{8,}$/,
    /^\d{2}\/\d{2}\s+WSID\d+$/,
    /^\d{4}\s+WSID\d+$/,
    /^\d{2}\/\d{2}\s+WSID:\S+$/,
    /^BIF TRANSFER (DR|KE)$/,
  ];

  function buildRows(tx) {
    return tx.map((t) => {
      const p0 = t.parts[0];
      let jenis = /^(TRSF|SWITCHING|BI-FAST)/.test(p0) ? p0.replace(/\s+(CR|DB)$/, '') : p0;
      jenis = jenis.replace(/\/PL$/, '');

      let tgl = t.tgl;
      let parts = [];
      for (let x of t.parts.slice(1)) {
        const m = x.match(/^TGL:\s*(\d{2}\/\d{2})$/);
        if (m) {
          tgl = tgl || m[1];
          continue;
        }
        if (DROP.some((d) => d.test(x))) continue;
        if (x === 'BIF BIAYA TXN KE') x = 'BIAYA TXN';
        parts.push(x);
      }
      const codes = parts.filter((x) => /^\d{4}$/.test(x));
      parts = parts.filter((x) => !/^\d{4}$/.test(x));
      let ex = t.extra.filter((x) => !/^\d+\.\d\d$/.test(x)).map((x) => x.replace(/\s{2,}/g, ' '));
      if (jenis === 'BI-FAST') ex = ex.filter((x) => !/^\d{3}$/.test(x));

      let d = '';
      for (const x of parts.concat(ex, codes)) {
        if (x.startsWith('/')) d = d ? d + ' / ' + x.slice(1).trim() : x;
        else d += (d ? ' - ' : '') + x;
      }
      return {
        tglMutasi: t.date,
        tglTransaksi: tgl,
        keterangan: jenis + (d ? ' - ' + d : ''),
        nominal: num(t.amt),
        tipe: t.tipe,
        saldo: t.saldo ? num(t.saldo) : null,
      };
    });
  }

  // ---------------------------------------------------------------
  // 4. Validasi terhadap ringkasan di halaman terakhir PDF
  // ---------------------------------------------------------------

  function r2(n) {
    return Math.round(n * 100) / 100;
  }

  function validate(rows, foot) {
    const checks = [];
    const cr = rows.filter((r) => r.tipe === 'CR');
    const db = rows.filter((r) => r.tipe === 'DB');
    const sumCr = r2(cr.reduce((a, r) => a + r.nominal, 0));
    const sumDb = r2(db.reduce((a, r) => a + r.nominal, 0));

    const add = (nama, ok, detail) => checks.push({ nama: nama, ok: ok, detail: detail });

    if (foot['MUTASI CR'] && foot['MUTASI DB'] && foot.awal !== undefined && foot['SALDO AKHIR']) {
      add('Jumlah transaksi CR', foot['MUTASI CR'].jumlah === cr.length, cr.length + ' dari ' + foot['MUTASI CR'].jumlah + ' di PDF');
      add('Jumlah transaksi DB', foot['MUTASI DB'].jumlah === db.length, db.length + ' dari ' + foot['MUTASI DB'].jumlah + ' di PDF');
      add('Total CR', Math.abs(sumCr - foot['MUTASI CR'].nilai) < 0.005, fmt(sumCr) + ' vs ' + fmt(foot['MUTASI CR'].nilai));
      add('Total DB', Math.abs(sumDb - foot['MUTASI DB'].nilai) < 0.005, fmt(sumDb) + ' vs ' + fmt(foot['MUTASI DB'].nilai));
      const hitung = r2(foot.awal + sumCr - sumDb);
      add('Saldo akhir', Math.abs(hitung - foot['SALDO AKHIR'].nilai) < 0.005, fmt(hitung) + ' vs ' + fmt(foot['SALDO AKHIR'].nilai));

      // saldo berjalan: setiap kali PDF mencantumkan saldo, harus sama dengan hitungan kita
      let run = foot.awal;
      let bad = 0;
      let firstBad = null;
      rows.forEach((r, i) => {
        run = r2(run + (r.tipe === 'CR' ? r.nominal : -r.nominal));
        if (r.saldo !== null && Math.abs(run - r.saldo) > 0.005) {
          bad++;
          if (firstBad === null) firstBad = i + 1;
          run = r.saldo; // sinkron ulang agar tidak berantai
        }
      });
      add('Saldo berjalan', bad === 0, bad === 0 ? 'semua titik saldo cocok' : bad + ' titik tidak cocok (mulai baris ' + firstBad + ')');
    } else {
      add('Ringkasan PDF', false, 'ringkasan di halaman terakhir tidak ditemukan');
    }
    return { ok: checks.every((c) => c.ok), checks: checks, sumCr: sumCr, sumDb: sumDb, nCr: cr.length, nDb: db.length };
  }

  function fmt(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------------------------------------------------------------
  // 5. Tulis ke Excel (ExcelJS)
  // ---------------------------------------------------------------

  const BULAN = {
    JANUARI: 'Januari', FEBRUARI: 'Februari', MARET: 'Maret', APRIL: 'April', MEI: 'Mei', JUNI: 'Juni',
    JULI: 'Juli', AGUSTUS: 'Agustus', SEPTEMBER: 'September', OKTOBER: 'Oktober', NOVEMBER: 'November', DESEMBER: 'Desember',
  };

  function periodeLabel(periode) {
    if (!periode) return 'Periode';
    const [b, y] = periode.split(/\s+/);
    return (BULAN[b] || b) + ' ' + y;
  }

  function buatWorkbook(ExcelJS, rows, foot, periode, noRek) {
    const wb = new ExcelJS.Workbook();
    const font = { name: 'Arial', size: 10 };
    const thin = { style: 'thin', color: { argb: 'FFBBBBBB' } };
    const border = { top: thin, left: thin, bottom: thin, right: thin };

    // --- sheet Mutasi
    const ws = wb.addWorksheet('Mutasi', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { width: 7 }, { width: 12 }, { width: 14 }, { width: 75 }, { width: 18 }, { width: 8 }, { width: 20 },
    ];
    const head = ws.addRow(['No', 'Tgl Mutasi', 'Tgl Transaksi', 'Keterangan / Berita / Nama', 'Nominal (Rp)', 'Tipe', 'Saldo Akhir (Rp)']);
    head.eachCell((c) => {
      c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = border;
    });
    rows.forEach((r, i) => {
      const row = ws.addRow([i + 1, r.tglMutasi, r.tglTransaksi, r.keterangan, r.nominal, r.tipe, r.saldo]);
      row.eachCell({ includeEmpty: true }, (c, col) => {
        c.font = font;
        c.border = border;
        if ([1, 2, 3, 6].includes(col)) c.alignment = { horizontal: 'center' };
      });
      row.getCell(5).numFmt = '#,##0.00';
      row.getCell(7).numFmt = '#,##0.00';
    });
    ws.autoFilter = { from: 'A1', to: 'G' + (rows.length + 1) };

    // --- sheet Ringkasan (rumus + hasil awal supaya langsung terbaca)
    const sr = wb.addWorksheet('Ringkasan');
    sr.columns = [{ width: 24 }, { width: 22 }, { width: 30 }];
    const sumCr = r2(rows.filter((r) => r.tipe === 'CR').reduce((a, r) => a + r.nominal, 0));
    const sumDb = r2(rows.filter((r) => r.tipe === 'DB').reduce((a, r) => a + r.nominal, 0));
    const nCr = rows.filter((r) => r.tipe === 'CR').length;
    const nDb = rows.length - nCr;
    const awal = foot.awal !== undefined ? foot.awal : 0;
    const akhirPdf = foot['SALDO AKHIR'] ? foot['SALDO AKHIR'].nilai : null;
    const akhirHitung = r2(awal + sumCr - sumDb);

    const data = [
      ['Keterangan', 'Nilai', 'Catatan'],
      ['Rekening', (noRek || '') + ' (Rekening Tahapan BCA), periode ' + periodeLabel(periode), null],
      ['Saldo awal', awal, 'Input dari PDF'],
      ['Total mutasi CR', { formula: 'SUMIF(Mutasi!F:F,"CR",Mutasi!E:E)', result: sumCr }, 'Dihitung dari sheet Mutasi'],
      ['Jumlah transaksi CR', { formula: 'COUNTIF(Mutasi!F:F,"CR")', result: nCr }, null],
      ['Total mutasi DB', { formula: 'SUMIF(Mutasi!F:F,"DB",Mutasi!E:E)', result: sumDb }, 'Dihitung dari sheet Mutasi'],
      ['Jumlah transaksi DB', { formula: 'COUNTIF(Mutasi!F:F,"DB")', result: nDb }, null],
      ['Saldo akhir (hitung)', { formula: 'B3+B4-B6', result: akhirHitung }, null],
      ['Saldo akhir (PDF)', akhirPdf, 'Input dari PDF'],
      ['Selisih', { formula: 'ROUND(B8-B9,2)', result: akhirPdf === null ? 0 : r2(akhirHitung - akhirPdf) }, 'Harus 0'],
    ];
    data.forEach((d, i) => {
      const row = sr.addRow(d);
      row.eachCell({ includeEmpty: true }, (c, col) => {
        if (i === 0) {
          c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
        } else {
          c.font = font;
          if (col === 2) {
            c.numFmt = '#,##0.00;(#,##0.00);-';
            c.alignment = { horizontal: 'right' };
          }
        }
      });
    });
    sr.getCell('B2').alignment = { horizontal: 'left' };
    ['B3', 'B9'].forEach((a) => (sr.getCell(a).font = { name: 'Arial', size: 10, color: { argb: 'FF0000FF' } }));
    ['B5', 'B7'].forEach((a) => (sr.getCell(a).numFmt = '#,##0'));
    return wb;
  }

  const api = {
    pagesFromPdf: pagesFromPdf,
    layoutText: layoutText,
    parseStatement: parseStatement,
    buildRows: buildRows,
    validate: validate,
    buatWorkbook: buatWorkbook,
    periodeLabel: periodeLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BCAParser = api;
})(typeof window !== 'undefined' ? window : this);
