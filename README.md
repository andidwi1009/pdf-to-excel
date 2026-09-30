# PDF Mutasi BCA ke Excel

Web statis untuk mengubah e-statement Rekening Tahapan BCA (PDF) menjadi Excel.
Semua proses berjalan di browser pengguna, tidak ada file yang diunggah ke server, dan tidak memakai AI.

## Isi folder

```
index.html     tampilan dan alur unggah/unduh
parser.js      inti: baca teks PDF, pecah per transaksi, validasi, tulis Excel
lib/           pdf.js (Apache-2.0) dan ExcelJS (MIT), disertakan supaya tidak bergantung CDN
```

Tidak ada langkah build. Semua file langsung disajikan apa adanya.

## Coba di komputer sendiri

Jangan buka `index.html` dengan klik dua kali (worker PDF bisa diblokir browser untuk alamat `file://`).
Jalankan server kecil dari folder ini:

```
python3 -m http.server 8000
```

lalu buka http://localhost:8000

## Deploy ke Vercel lewat GitHub

1. Buat repo baru di GitHub, lalu unggah seluruh isi folder ini (termasuk folder `lib`).
2. Di Vercel: Add New > Project > pilih repo tadi.
3. Framework Preset: **Other**. Build Command dan Output Directory dikosongkan.
4. Klik Deploy.

Alternatif gratis lain: GitHub Pages (Settings > Pages > Deploy from a branch > `main` / root).

## Cara kerja

1. `pdf.js` mengambil teks beserta posisinya. Item teks disusun ulang per baris, dan jarak antar kolom
   diterjemahkan menjadi spasi supaya bentuknya mirip keluaran `pdftotext -layout`.
2. Baris yang diawali tanggal `dd/mm` dianggap awal transaksi. Nominal ada di ujung baris,
   akhiran `DB` berarti debit (selain itu CR), angka kedua di ujung baris adalah saldo.
   Baris `TANGGAL : dd/mm` menjadi Tgl Transaksi. Baris di bawahnya menjadi keterangan.
3. Kode referensi (misalnya `31/03 /95031/00000`, `0104/FTSCY/WS95011`, `TRANSFER DR 110`) dibuang.
4. Hasil dicocokkan dengan ringkasan di halaman terakhir PDF: jumlah transaksi CR/DB, total CR/DB,
   saldo akhir, dan saldo berjalan di setiap titik yang mencantumkan saldo.
   Kalau ada yang tidak cocok, file ditandai "Perlu dicek".
5. ExcelJS menulis file `.xlsx` berisi sheet `Mutasi` dan sheet `Ringkasan` (memakai rumus).

## Keterbatasan

- Hanya e-statement BCA yang berisi teks. PDF hasil scan atau foto tidak didukung (butuh OCR).
- Aturan pembersihan keterangan ada di `parser.js` (`DROP` dan `buildRows`). Kalau BCA mengubah format
  atau muncul jenis transaksi baru yang keterangannya aneh, cukup sesuaikan bagian itu.
- Bank lain butuh aturan sendiri.

## Pengujian

Parser ini dibandingkan baris demi baris dengan hasil konversi sebelumnya untuk 24 PDF
(Juni 2020 sampai Desember 2021 dan Januari sampai Juni 2023). Semua cocok, dan semua lolos
pengecekan ringkasan serta saldo berjalan.

## Lisensi pihak ketiga

- pdf.js: Apache License 2.0 (`lib/pdfjs-LICENSE.txt`)
- ExcelJS: MIT (`lib/exceljs-LICENSE.txt`)
