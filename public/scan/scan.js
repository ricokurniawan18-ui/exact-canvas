/* Scan dokumen dari foto — pengganti aplikasi scanner terpisah.
   Alur: ambil foto (kamera/galeri) → sudut dokumen dideteksi otomatis →
   pengguna bisa menggeser 4 sudut → filter warna → semua digabung jadi satu PDF.

   Seluruh proses berjalan di peramban; tidak ada foto yang dikirim ke server
   sebelum pengguna menekan "Buat PDF".

   Dua tingkat resolusi dipakai supaya hasilnya tajam TAPI editornya tetap enteng:
   - `hal.kerja` : salinan kecil, untuk editor, deteksi tepi, dan pratinjau.
   - `hal.asli`  : foto resolusi penuh, hanya diolah sekali saat PDF dibuat.
   Sudut disimpan dalam koordinat `kerja` lalu diskalakan saat render akhir. */
window.Scan = (function () {
  'use strict';

  const RES_ASLI = 3400;        // batas simpan foto asli (di atas ini jarang berguna)
  const RES_EDITOR = 1000;      // gambar kerja untuk editor — enteng digeser di HP
  const MUTU_JPEG = 0.92;

  // Pilihan ketajaman hasil. Angka = sisi terpanjang halaman jadi.
  const MUTU = [
    { id: 'hemat', label: 'Hemat', px: 1700, ket: 'Berkas kecil, cukup untuk teks besar' },
    { id: 'bagus', label: 'Bagus', px: 2480, ket: 'Setara 210 dpi di A4 — pilihan biasa' },
    { id: 'maks', label: 'Maksimal', px: 3300, ket: 'Setara 280 dpi — untuk teks kecil & gambar' },
  ];

  const KERTAS = [
    { id: 'a4', label: 'A4', w: 595.28, h: 841.89 },
    { id: 'f4', label: 'F4/Folio', w: 609.45, h: 935.43 },
    { id: 'auto', label: 'Ikut bentuk dokumen', w: 0, h: 0 },
  ];

  /* Urutan sengaja dari yang paling irit ke yang paling boros tinta, karena
     itulah pertanyaan pertama pelanggan: "yang mana yang murah?" */
  const FILTER = [
    { id: 'hemat', label: 'Hemat Tinta', hemat: true,
      ket: 'Dua warna, garis ditipiskan, tinta dibuat abu — paling irit untuk cetakan banyak' },
    { id: 'hitamputih', label: 'Hitam Putih', hemat: true,
      ket: 'Dua warna hitam pekat. Paling tajam untuk teks dan tetap irit' },
    { id: 'teks', label: 'Teks Tajam',
      ket: 'Abu-abu berkontras tinggi. Untuk teks kecil yang pecah bila dijadikan dua warna' },
    { id: 'tingkatkan', label: 'Peningkatan',
      ket: 'Warna dipertahankan, bayangan dihapus, kertas jadi putih bersih' },
    { id: 'abu', label: 'Abu-abu',
      ket: 'Untuk dokumen berisi foto atau gambar, dicetak di printer hitam putih' },
    { id: 'asli', label: 'Asli',
      ket: 'Warna apa adanya, hanya diluruskan — paling boros tinta' },
  ];

  // Filter dua warna: kenop yang berlaku padanya berbeda dari filter bergradasi.
  const DUA_WARNA = ['hitamputih', 'hemat'];

  const DPI_MINIMAL = 150;      // di bawah ini hasil cetak mulai terlihat kabur

  let lapis = null;
  let selesaiCb = null;
  let halaman = [];
  let aliranKamera = null;
  let nomorHal = 0;
  let mutu = 'bagus';
  let kertas = 'a4';
  // Pilihan filter terakhir jadi bawaan halaman berikutnya — orang yang scan 30
  // lembar tidak mau memilih "Hemat Tinta" tiga puluh kali.
  let filterBawaan = 'tingkatkan';
  /* Mode cepat (Exact Canvas, permintaan print): foto → sudut dan filter
     otomatis → PDF langsung jadi, tanpa layar daftar. Halamannya disimpan di
     `simpananCepat` supaya bisa dibuka lagi lewat Scan.ubah() kalau ada yang
     perlu dibetulkan — edit hanya kalau perlu. */
  let modeCepat = false;
  let simpananCepat = null;
  /* Pesan yang perlu dibaca pengguna di layar daftar halaman.

     TIDAK memakai alert(): kotak bawaan peramban memblokir seluruh halaman
     sampai ditekan — di HP ia menutupi hasil yang justru sedang ingin dilihat,
     dan di peramban tanpa orang ia menggantung tanpa batas. */
  let catatanDaftar = '';

  const $ = (s, i) => (i || document).querySelector(s);
  const $$ = (s, i) => [...(i || document).querySelectorAll(s)];
  const lolos = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jeda = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  // ══ Titik masuk ═══════════════════════════════════════════════════════════
  function buka(opsi = {}) {
    selesaiCb = opsi.selesai || (() => {});
    modeCepat = !!opsi.cepat;
    if (opsi.filter) filterBawaan = opsi.filter;
    halaman = [];
    nomorHal = 0;
    buatLapis();
    if (opsi.foto?.length) {
      tampilDaftar();
      tambahDariBerkas(opsi.foto);
    } else if (opsi.kamera) {
      tampilKamera();
    } else {
      tampilDaftar();
    }
  }

  function tutup() {
    hentikanKamera();
    if (lapis) lapis.remove();
    lapis = null;
    halaman = [];
  }

  /* Dua masukan berkas, dua tujuan berbeda:
     - scanInputFoto  : galeri, boleh banyak sekaligus.
     - scanInputKamera: atribut `capture` menyuruh HP membuka aplikasi kameranya
       sendiri. Jalur ini TIDAK memakai getUserMedia, jadi tetap bekerja di
       alamat http biasa dan tanpa izin kamera peramban — inilah jalan keluar
       saat kamera langsung diblokir. */
  function buatLapis() {
    lapis = document.createElement('div');
    lapis.className = 'scan-lapis';
    lapis.innerHTML = `
      <div class="scan-bar">
        <div style="flex:1">
          <h3 id="scanJudul">Scan Dokumen</h3>
          <div class="sub" id="scanSub"></div>
        </div>
        <button class="scan-tutup" id="scanTutup" aria-label="Tutup">×</button>
      </div>
      <div class="scan-isi" id="scanIsi"></div>
      <div class="scan-kaki" id="scanKaki"></div>
      <input type="file" id="scanInputFoto" accept="image/*" multiple hidden>
      <input type="file" id="scanInputKamera" accept="image/*" capture="environment" hidden>`;
    document.body.appendChild(lapis);
    document.body.style.overflow = 'hidden';

    $('#scanTutup', lapis).onclick = () => {
      if (halaman.length && !confirm('Tutup scanner? Hasil scan yang belum dijadikan PDF akan hilang.')) return;
      document.body.style.overflow = '';
      tutup();
    };
    const terimaBerkas = (e) => {
      const f = [...e.target.files];
      e.target.value = '';
      if (f.length) { tampilDaftar(); tambahDariBerkas(f); }
    };
    $('#scanInputFoto', lapis).onchange = terimaBerkas;
    $('#scanInputKamera', lapis).onchange = terimaBerkas;
  }

  function judul(teks, sub) {
    $('#scanJudul', lapis).textContent = teks;
    $('#scanSub', lapis).textContent = sub || '';
  }

  function sibuk(teks) {
    const isi = $('#scanIsi', lapis);
    let el = $('.scan-sibuk', isi);
    if (!teks) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'scan-sibuk';
      isi.appendChild(el);
    }
    el.innerHTML = `<span class="pemuat gelap"></span><span>${lolos(teks)}</span>`;
  }

  // ══ Kamera ════════════════════════════════════════════════════════════════
  /* Kamera langsung (getUserMedia) hanya hidup di "secure context": https atau
     localhost. Dibuka lewat http://192.168.x.x, `navigator.mediaDevices` tidak
     ada sama sekali — bukan izin yang ditolak, melainkan API-nya memang tidak
     disediakan peramban. Diperiksa di muka supaya pesannya tepat sasaran. */
  function kameraLangsungTersedia() {
    return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
  }

  /** Kotak penjelasan + jalan keluar yang selalu bisa dipakai. */
  function tampilGagalKamera(alasan, saran) {
    const isi = $('#scanIsi', lapis);
    isi.innerHTML = `<div class="scan-galat">
      <p>${lolos(alasan)}</p>
      ${saran ? `<p class="scan-label" style="margin-bottom:14px">${saran}</p>` : ''}
      <button class="tombol" id="scanKameraBawaan">📷 Pakai kamera HP</button>
      <button class="tombol netral" id="scanGantiGaleri" style="margin-top:9px">🖼️ Ambil dari galeri</button>
    </div>`;
    $('#scanKameraBawaan', lapis).onclick = () => $('#scanInputKamera', lapis).click();
    $('#scanGantiGaleri', lapis).onclick = () => $('#scanInputFoto', lapis).click();
    $('#scanKaki', lapis).innerHTML = '';
  }

  async function tampilKamera() {
    judul('Ambil Foto Dokumen', 'Foto boleh miring — nanti diluruskan otomatis');
    const isi = $('#scanIsi', lapis);

    if (!kameraLangsungTersedia()) {
      /* Alamat aman TIDAK boleh dikarang dari alamat sekarang: menyarankan
         "https://192.168.1.5" hanya membuat pengguna menemui galat sertifikat.
         Alamat publik toko datang dari pengaturan; kalau belum diisi, lebih
         baik tidak menyebut alamat apa pun. */
      const aman = String(window.EP_ALAMAT_AMAN || '').trim();
      return tampilGagalKamera(
        'Kamera langsung tidak bisa dipakai karena halaman ini dibuka lewat alamat biasa (http). '
        + 'Peramban HP hanya mengizinkan kamera pada alamat https.',
        'Tetap bisa memotret lewat aplikasi kamera HP — tekan tombol di bawah.'
        + (aman
          ? ` Untuk kamera langsung dengan panduan sudut, buka situs ini di <b>${lolos(aman)}</b>.`
          : ' Untuk kamera langsung dengan panduan sudut, buka situs ini lewat alamat https toko.'),
      );
    }
    isi.innerHTML = `
      <div class="scan-kamera">
        <video id="scanVideo" playsinline autoplay muted></video>
        <div class="scan-panduan"></div>
        <div class="scan-petunjuk">Isi layar dengan dokumennya, pastikan keempat sudut terlihat dan cahaya merata.</div>
      </div>`;
    $('#scanKaki', lapis).innerHTML = `
      <button class="tombol netral kecil" id="scanKeGaleri">🖼️ Galeri</button>
      <button class="scan-jepret" id="scanJepret" aria-label="Ambil foto"></button>
      <button class="tombol kecil" id="scanKeDaftar" style="min-width:96px">Selesai (0)</button>`;

    $('#scanKeGaleri', lapis).onclick = () => $('#scanInputFoto', lapis).click();
    $('#scanKeDaftar', lapis).onclick = () => {
      hentikanKamera();
      tampilDaftar();
      if (modeCepat && halaman.length) void siapLaluPdf();
    };
    $('#scanJepret', lapis).onclick = jepret;

    try {
      // Minta resolusi setinggi mungkin — inilah bahan mentah ketajaman cetak.
      aliranKamera = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 3840 },
          height: { ideal: 2880 },
        },
        audio: false,
      });
      $('#scanVideo', lapis).srcObject = aliranKamera;
    } catch (e) {
      /* Tiap sebab punya jalan keluarnya sendiri. Pesan seragam "kamera tidak
         bisa dibuka" membuat pengguna mengira aplikasinya rusak, padahal yang
         perlu dilakukan berbeda-beda. */
      const per = {
        NotAllowedError: [
          'Izin kamera ditolak untuk situs ini.',
          'Aktifkan lagi lewat ikon gembok di bilah alamat peramban, lalu coba lagi. '
          + 'Atau potret langsung dengan aplikasi kamera HP lewat tombol di bawah.',
        ],
        NotFoundError: [
          'Tidak ada kamera yang terpasang di perangkat ini.',
          'Kalau ini komputer tanpa webcam, potret dokumennya dengan HP lalu pilih dari galeri.',
        ],
        NotReadableError: [
          'Kamera sedang dipakai aplikasi lain.',
          'Tutup aplikasi yang sedang memakai kamera (video call, aplikasi kamera), lalu coba lagi.',
        ],
        OverconstrainedError: [
          'Kamera perangkat ini tidak mendukung resolusi yang diminta.',
          'Pakai aplikasi kamera HP lewat tombol di bawah — hasilnya sama saja.',
        ],
        SecurityError: [
          'Peramban memblokir kamera pada halaman ini.',
          'Biasanya karena halaman dibuka lewat alamat http biasa. Pakai alamat https, '
          + 'atau potret lewat aplikasi kamera HP di bawah.',
        ],
      };
      const [alasan, saran] = per[e.name] || [
        `Kamera tidak bisa dibuka (${e.name || 'sebab tidak diketahui'}).`,
        'Potret lewat aplikasi kamera HP di bawah — cara ini bekerja di semua perangkat.',
      ];
      tampilGagalKamera(alasan, saran);
    }
  }

  function hentikanKamera() {
    if (aliranKamera) {
      aliranKamera.getTracks().forEach((t) => t.stop());
      aliranKamera = null;
    }
  }

  async function jepret() {
    const video = $('#scanVideo', lapis);
    if (!video?.videoWidth) return;
    const kanvas = document.createElement('canvas');
    kanvas.width = video.videoWidth;
    kanvas.height = video.videoHeight;
    kanvas.getContext('2d').drawImage(video, 0, 0);

    const tombol = $('#scanJepret', lapis);
    tombol.style.background = '#60a5fa';
    setTimeout(() => { tombol.style.background = '#fff'; }, 130);

    await tambahHalaman(kanvas);
    const hitung = $('#scanKeDaftar', lapis);
    if (hitung) hitung.textContent = `Selesai (${halaman.length})`;
  }

  // ══ Menambah halaman ══════════════════════════════════════════════════════
  async function tambahDariBerkas(daftar) {
    let ke = 0;
    for (const berkas of daftar) {
      if (!berkas.type.startsWith('image/')) continue;
      ke += 1;
      sibuk(`Membaca foto ${ke} dari ${daftar.length}…`);
      await jeda(0);
      try {
        const gambar = await muatGambar(berkas);
        await tambahHalaman(gambar);
        gambarDaftar();
      } catch {
        /* satu foto rusak tidak boleh menggagalkan sisanya */
      }
    }
    sibuk('');
    gambarDaftar();
    if (modeCepat) await siapLaluPdf();
  }

  function muatGambar(berkas) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(berkas);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Foto tidak terbaca.')); };
      img.src = url;
    });
  }

  function kecilkan(sumber, batas) {
    const w = sumber.naturalWidth || sumber.width;
    const h = sumber.naturalHeight || sumber.height;
    const skala = Math.min(1, batas / Math.max(w, h));
    if (skala === 1 && sumber.tagName !== 'IMG') return sumber;
    const kanvas = document.createElement('canvas');
    kanvas.width = Math.max(1, Math.round(w * skala));
    kanvas.height = Math.max(1, Math.round(h * skala));
    const ctx = kanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sumber, 0, 0, kanvas.width, kanvas.height);
    return kanvas;
  }

  /**
   * Menambah satu halaman dari sebuah gambar.
   *
   * opsi.sudahLurus — gambarnya sudah diluruskan (mis. hasil pisah halaman),
   *   jadi deteksi tepi dilewati dan sudutnya dipasang penuh. Menjalankan
   *   deteksi pada gambar yang sudah rapi justru merugikan: ia akan mencari
   *   "kertas" di dalam kertas dan memotong isinya.
   * opsi.warisi — menyalin pengaturan warna dari halaman lain, supaya dua
   *   belahan buku tidak perlu diatur ulang satu per satu.
   * opsi.sisipkanDi — posisi dalam daftar; dipakai agar halaman hasil pisah
   *   berada di tempat halaman asalnya, bukan di paling belakang.
   */
  async function tambahHalaman(sumber, opsi = {}) {
    nomorHal += 1;
    const asli = kecilkan(sumber, RES_ASLI);
    const kerja = kecilkan(asli, RES_EDITOR);
    const w = opsi.warisi || {};
    const hal = {
      id: nomorHal,
      asli,
      kerja,
      skala: asli.width / kerja.width,      // pengali koordinat kerja → asli
      sudut: opsi.sudahLurus
        ? [{ x: 0, y: 0 }, { x: kerja.width, y: 0 },
          { x: kerja.width, y: kerja.height }, { x: 0, y: kerja.height }]
        : cariSudutDokumen(kerja),
      filter: w.filter || filterBawaan,
      rotasi: 0,
      cerah: w.cerah ?? 0,                   // −100..100
      kontras: w.kontras ?? 0,               // −100..100
      bayangan: w.bayangan ?? 100,           // 0..100 — kekuatan perataan cahaya
      tinta: w.tinta ?? 62,                  // 0..100 — kepekatan tinta mode Hemat
      kecil: null,
      tinta_pakai: null,                     // perkiraan pemakaian tinta, 0..1
      tinta_asli: null,                      // pembanding: foto tanpa filter
      diproses: false,
    };
    if (Number.isInteger(opsi.sisipkanDi)) halaman.splice(opsi.sisipkanDi, 0, hal);
    else halaman.push(hal);
    prosesPratinjau(hal).then(() => gambarDaftar());
    return hal;
  }

  // ══ Pisah halaman ganda ═══════════════════════════════════════════════════
  /* Mencari LIPATAN buku: garis tegak paling gelap di sepertiga tengah gambar.

     Buku terbuka selalu meninggalkan bayangan memanjang di tempat kedua
     halaman bertemu, dan bayangan itu jauh lebih gelap daripada kertas di
     kanan-kirinya. Membelah tepat di tengah 50/50 hampir selalu meleset —
     posisi buku di foto jarang simetris, dan hasilnya satu halaman terpotong
     sementara halaman lain kebagian pinggiran halaman sebelahnya. */
  function cariLipatan(kanvas) {
    const ctx = kanvas.getContext('2d', { willReadFrequently: true });
    const w = kanvas.width;
    const h = kanvas.height;
    const dari = Math.floor(w * 0.33);
    const sampai = Math.ceil(w * 0.67);
    const data = ctx.getImageData(dari, 0, sampai - dari, h).data;
    const lebar = sampai - dari;

    const terang = new Float64Array(lebar);
    for (let x = 0; x < lebar; x += 1) {
      let jumlah = 0;
      for (let y = 0; y < h; y += 1) {
        const t = (y * lebar + x) * 4;
        jumlah += data[t] * 0.299 + data[t + 1] * 0.587 + data[t + 2] * 0.114;
      }
      terang[x] = jumlah / h;
    }

    /* Diratakan dulu dengan jendela kecil: satu kolom gelap bisa saja cuma
       bekas tulisan tegak, sedangkan lipatan buku selalu gelap selebar
       beberapa kolom sekaligus. */
    const r = Math.max(2, Math.round(w * 0.004));
    let terbaik = 0;
    let paling = Infinity;
    for (let x = r; x < lebar - r; x += 1) {
      let jumlah = 0;
      for (let d = -r; d <= r; d += 1) jumlah += terang[x + d];
      const rata = jumlah / (2 * r + 1);
      if (rata < paling) { paling = rata; terbaik = x; }
    }

    const rataSemua = terang.reduce((a, b) => a + b, 0) / lebar;

    /* Dua syarat, bukan satu.

       GELAP saja tidak cukup: satu kolom hitam setipis piksel — huruf tegak,
       garis tabel, tepi gambar — sudah bisa menarik rata-rata jendela ke bawah
       dan dikira lipatan. Lipatan buku selalu gelap SELEBAR beberapa kolom
       sekaligus, jadi lebarnya ikut diperiksa. */
    let kolomGelap = 0;
    for (let d = -r; d <= r; d += 1) {
      if (terang[terbaik + d] < rataSemua * 0.85) kolomGelap += 1;
    }
    const cukupLebar = kolomGelap >= Math.max(3, Math.round(r * 0.8));
    const meyakinkan = paling < rataSemua * 0.92 && cukupLebar;
    return {
      proporsi: meyakinkan ? (dari + terbaik) / w : 0.5,
      meyakinkan,
    };
  }

  function potong(kanvas, dariX, lebarX) {
    const hasil = document.createElement('canvas');
    hasil.width = Math.max(1, Math.round(lebarX));
    hasil.height = kanvas.height;
    hasil.getContext('2d').drawImage(kanvas, Math.round(dariX), 0, hasil.width, kanvas.height,
      0, 0, hasil.width, kanvas.height);
    return hasil;
  }

  /**
   * Membelah satu halaman jadi dua di lipatan bukunya.
   * Halaman asal digantikan oleh dua halaman baru, di posisi yang sama.
   */
  async function pisahDuaHalaman(hal) {
    // Diluruskan dan diputar DULU, supaya sumbu belahnya benar-benar tegak.
    const sudutAsli = hal.sudut.map((p) => ({ x: p.x * hal.skala, y: p.y * hal.skala }));
    let penuh = luruskan(hal.asli, sudutAsli, RES_ASLI);
    penuh = putar(penuh, hal.rotasi);

    const { proporsi, meyakinkan } = cariLipatan(kecilkan(penuh, 700));
    const batas = Math.round(penuh.width * proporsi);

    const posisi = halaman.indexOf(hal);
    halaman.splice(posisi, 1);
    await tambahHalaman(potong(penuh, 0, batas),
      { sudahLurus: true, warisi: hal, sisipkanDi: posisi });
    await tambahHalaman(potong(penuh, batas, penuh.width - batas),
      { sudahLurus: true, warisi: hal, sisipkanDi: posisi + 1 });
    return { meyakinkan, proporsi };
  }

  // ══ Deteksi sudut dokumen ═════════════════════════════════════════════════
  /* Gambar dikecilkan, diubah jadi abu-abu, lalu dipisah terang/gelap dengan
     ambang Otsu. Bidang terang terbesar dianggap kertas; empat sudutnya diambil
     dari titik ekstrem diagonal. Cara ini bekerja baik untuk kertas di atas alas
     yang lebih gelap. Kalau meleset, pengguna tinggal menggeser titik sudutnya —
     itu sebabnya empat titik selalu bisa digeser manual. */
  function cariSudutDokumen(kanvas) {
    const penuh = [
      { x: 0, y: 0 }, { x: kanvas.width, y: 0 },
      { x: kanvas.width, y: kanvas.height }, { x: 0, y: kanvas.height },
    ];
    try {
      const L = 240;
      const skala = L / Math.max(kanvas.width, kanvas.height);
      const w = Math.max(8, Math.round(kanvas.width * skala));
      const h = Math.max(8, Math.round(kanvas.height * skala));
      const kecil = document.createElement('canvas');
      kecil.width = w; kecil.height = h;
      kecil.getContext('2d').drawImage(kanvas, 0, 0, w, h);
      const data = kecil.getContext('2d').getImageData(0, 0, w, h).data;

      const abu = new Uint8Array(w * h);
      const histogram = new Uint32Array(256);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        abu[p] = g;
        histogram[g] += 1;
      }

      const ambang = otsu(histogram, w * h);
      const mask = new Uint8Array(w * h);
      for (let p = 0; p < abu.length; p += 1) mask[p] = abu[p] > ambang ? 1 : 0;

      tutupCelahTegak(mask, w, h, Math.max(2, Math.round(w * 0.06)));
      const wilayah = komponenTerbesar(mask, w, h);
      if (!wilayah || wilayah.jumlah < w * h * 0.12) return penuh;

      let ka = null; let kb = null; let kc = null; let kd = null;
      let minS = Infinity; let maksS = -Infinity; let minD = Infinity; let maksD = -Infinity;
      for (const p of wilayah.titik) {
        const s = p.x + p.y;
        const d = p.x - p.y;
        if (s < minS) { minS = s; ka = p; }
        if (s > maksS) { maksS = s; kc = p; }
        if (d > maksD) { maksD = d; kb = p; }
        if (d < minD) { minD = d; kd = p; }
      }
      if (!ka || !kb || !kc || !kd) return penuh;

      const balik = (p) => ({
        x: Math.max(0, Math.min(kanvas.width, p.x / skala)),
        y: Math.max(0, Math.min(kanvas.height, p.y / skala)),
      });
      const sudut = [balik(ka), balik(kb), balik(kc), balik(kd)];
      if (luasSegiempat(sudut) < kanvas.width * kanvas.height * 0.15) return penuh;
      return susutkan(sudut, 0.012);
    } catch {
      return penuh;
    }
  }

  /* Menjembatani celah GELAP yang sempit di dalam bidang terang, baris per baris.

     Ini yang membuat foto BUKU TERBUKA dikenali sebagai satu bidang kertas.
     Lipatan buku adalah pita gelap memanjang di tengah kertas; tanpa dijembatani,
     ambang Otsu memutus kertas jadi dua wilayah terpisah, lalu "wilayah terbesar"
     hanya mengambil SATU halaman — dan halaman satunya lagi ikut terbuang saat
     foto diluruskan.

     Hanya celah yang lebih sempit dari `maksCelah` yang dijembatani, jadi jarak
     antara dua lembar kertas yang benar-benar terpisah tetap dianggap pemisah. */
  function tutupCelahTegak(mask, w, h, maksCelah) {
    for (let y = 0; y < h; y += 1) {
      const baris = y * w;
      let x = 0;
      while (x < w) {
        if (mask[baris + x]) { x += 1; continue; }
        let akhir = x;
        while (akhir < w && !mask[baris + akhir]) akhir += 1;
        const lebarCelah = akhir - x;
        // Dijembatani hanya bila celahnya diapit bidang terang di kedua sisi.
        const adaKiri = x > 0;
        const adaKanan = akhir < w;
        if (adaKiri && adaKanan && lebarCelah <= maksCelah) {
          for (let i = x; i < akhir; i += 1) mask[baris + i] = 1;
        }
        x = akhir;
      }
    }
  }

  function otsu(histogram, total) {
    let jumlah = 0;
    for (let i = 0; i < 256; i += 1) jumlah += i * histogram[i];
    let jumlahB = 0; let bobotB = 0; let maks = 0; let ambang = 128;
    for (let i = 0; i < 256; i += 1) {
      bobotB += histogram[i];
      if (!bobotB) continue;
      const bobotF = total - bobotB;
      if (!bobotF) break;
      jumlahB += i * histogram[i];
      const rerataB = jumlahB / bobotB;
      const rerataF = (jumlah - jumlahB) / bobotF;
      const antar = bobotB * bobotF * (rerataB - rerataF) ** 2;
      if (antar > maks) { maks = antar; ambang = i; }
    }
    return ambang;
  }

  function komponenTerbesar(mask, w, h) {
    const label = new Int32Array(w * h).fill(-1);
    let terbaik = null;
    for (let awal = 0; awal < mask.length; awal += 1) {
      if (!mask[awal] || label[awal] !== -1) continue;
      const antre = [awal];
      const titik = [];
      label[awal] = awal;
      while (antre.length) {
        const p = antre.pop();
        const x = p % w;
        const y = (p / w) | 0;
        titik.push({ x, y });
        if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = awal; antre.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = awal; antre.push(p + 1); }
        if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = awal; antre.push(p - w); }
        if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = awal; antre.push(p + w); }
      }
      if (!terbaik || titik.length > terbaik.jumlah) terbaik = { jumlah: titik.length, titik };
    }
    return terbaik;
  }

  /* Menarik keempat sudut sedikit ke arah pusat. Ambang Otsu hampir selalu
     menganggap bayangan tipis di sekeliling kertas sebagai bagian kertas;
     kalau ikut terbawa, pinggiran hasil jadi hitam pekat saat difilter. */
  function susutkan(sudut, bagian) {
    const pusat = sudut.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    return sudut.map((p) => ({
      x: p.x + (pusat.x - p.x) * bagian,
      y: p.y + (pusat.y - p.y) * bagian,
    }));
  }

  function luasSegiempat(s) {
    let luas = 0;
    for (let i = 0; i < s.length; i += 1) {
      const a = s[i];
      const b = s[(i + 1) % s.length];
      luas += a.x * b.y - b.x * a.y;
    }
    return Math.abs(luas) / 2;
  }

  // ══ Koreksi perspektif ════════════════════════════════════════════════════
  function homografi(sumber, tujuan) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i += 1) {
      const { x, y } = sumber[i];
      const { x: u, y: v } = tujuan[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = selesaikan(A, b);
    return h ? [...h, 1] : null;
  }

  function selesaikan(A, b) {
    const n = b.length;
    const M = A.map((baris, i) => [...baris, b[i]]);
    for (let k = 0; k < n; k += 1) {
      let pivot = k;
      for (let i = k + 1; i < n; i += 1) if (Math.abs(M[i][k]) > Math.abs(M[pivot][k])) pivot = i;
      if (Math.abs(M[pivot][k]) < 1e-10) return null;
      [M[k], M[pivot]] = [M[pivot], M[k]];
      for (let i = k + 1; i < n; i += 1) {
        const f = M[i][k] / M[k][k];
        for (let j = k; j <= n; j += 1) M[i][j] -= f * M[k][j];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i -= 1) {
      let jml = M[i][n];
      for (let j = i + 1; j < n; j += 1) jml -= M[i][j] * x[j];
      x[i] = jml / M[i][i];
    }
    return x;
  }

  // Ukuran hasil diambil dari sisi terpanjang segi empat sumber supaya proporsi
  // dokumen tidak berubah, lalu diskalakan ke batas resolusi yang diminta.
  function ukuranHasil(sudut, batas) {
    const jarak = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const lebar = Math.max(jarak(sudut[0], sudut[1]), jarak(sudut[3], sudut[2]));
    const tinggi = Math.max(jarak(sudut[0], sudut[3]), jarak(sudut[1], sudut[2]));
    const skala = Math.min(1, (batas || RES_EDITOR) / Math.max(lebar, tinggi));
    return {
      w: Math.max(50, Math.round(lebar * skala)),
      h: Math.max(50, Math.round(tinggi * skala)),
    };
  }

  function luruskan(kanvasSumber, sudut, batas) {
    const { w, h } = ukuranHasil(sudut, batas);
    const H = homografi(
      [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
      sudut,
    );
    const hasil = document.createElement('canvas');
    hasil.width = w; hasil.height = h;
    if (!H) { hasil.getContext('2d').drawImage(kanvasSumber, 0, 0, w, h); return hasil; }

    const ctxS = kanvasSumber.getContext('2d', { willReadFrequently: true });
    const src = ctxS.getImageData(0, 0, kanvasSumber.width, kanvasSumber.height);
    const sw = src.width;
    const sh = src.height;
    const sd = src.data;

    const ctxH = hasil.getContext('2d');
    const out = ctxH.createImageData(w, h);
    const od = out.data;

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const d = H[6] * x + H[7] * y + H[8];
        const sx = (H[0] * x + H[1] * y + H[2]) / d;
        const sy = (H[3] * x + H[4] * y + H[5]) / d;
        const t = (y * w + x) * 4;

        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
          od[t] = od[t + 1] = od[t + 2] = 255;
          od[t + 3] = 255;
          continue;
        }
        const x0 = sx | 0;
        const y0 = sy | 0;
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const p00 = (y0 * sw + x0) * 4;
        const p10 = (y0 * sw + x1) * 4;
        const p01 = (y1 * sw + x0) * 4;
        const p11 = (y1 * sw + x1) * 4;
        for (let c = 0; c < 3; c += 1) {
          const atas = sd[p00 + c] * (1 - fx) + sd[p10 + c] * fx;
          const bawah = sd[p01 + c] * (1 - fx) + sd[p11 + c] * fx;
          od[t + c] = (atas * (1 - fy) + bawah * fy) | 0;
        }
        od[t + 3] = 255;
      }
    }
    ctxH.putImageData(out, 0, 0);
    return hasil;
  }

  // ══ Peta cahaya latar ═════════════════════════════════════════════════════
  /* Bayangan dan cahaya tidak rata berubah PERLAHAN di seluruh gambar, jadi
     petanya cukup dihitung pada versi kecil lalu direntang balik. Ini yang
     membuat perataan cahaya dan ambang adaptif tetap murah pada foto 3000 piksel
     — menghitung integral image di resolusi penuh butuh ratusan megabita. */
  function petaLatar(d, w, h, radiusRelatif) {
    const KECIL = 160;
    const skala = Math.min(1, KECIL / Math.max(w, h));
    const mw = Math.max(4, Math.round(w * skala));
    const mh = Math.max(4, Math.round(h * skala));

    // Turunkan ke ukuran peta dengan rata-rata blok (bukan ambil sampel),
    // supaya bintik tinta tidak ikut jadi "latar".
    const jml = new Float32Array(mw * mh);
    const cacah = new Uint32Array(mw * mh);
    for (let y = 0; y < h; y += 1) {
      const my = Math.min(mh - 1, (y * mh / h) | 0);
      for (let x = 0; x < w; x += 1) {
        const mx = Math.min(mw - 1, (x * mw / w) | 0);
        const p = my * mw + mx;
        const t = (y * w + x) * 4;
        jml[p] += d[t] * 0.299 + d[t + 1] * 0.587 + d[t + 2] * 0.114;
        cacah[p] += 1;
      }
    }
    const kasar = new Float32Array(mw * mh);
    for (let p = 0; p < kasar.length; p += 1) kasar[p] = cacah[p] ? jml[p] / cacah[p] : 255;

    // Latar = nilai TERANG di sekitar (persentil atas), bukan rata-rata —
    // supaya blok yang penuh teks tidak dikira kertas gelap.
    const r = Math.max(1, Math.round(Math.min(mw, mh) * radiusRelatif));
    const halus = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y += 1) {
      for (let x = 0; x < mw; x += 1) {
        let maks = 0;
        let kedua = 0;
        for (let dy = -r; dy <= r; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= mh) continue;
          for (let dx = -r; dx <= r; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= mw) continue;
            const v = kasar[yy * mw + xx];
            if (v > maks) { kedua = maks; maks = v; } else if (v > kedua) { kedua = v; }
          }
        }
        halus[y * mw + x] = kedua || maks || 255;
      }
    }
    return { data: halus, w: mw, h: mh };
  }

  // Ambil nilai latar untuk satu piksel gambar penuh, dengan interpolasi bilinear.
  function nilaiLatar(peta, x, y, w, h) {
    const fx = Math.min(peta.w - 1, Math.max(0, (x + 0.5) * peta.w / w - 0.5));
    const fy = Math.min(peta.h - 1, Math.max(0, (y + 0.5) * peta.h / h - 0.5));
    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = Math.min(peta.w - 1, x0 + 1);
    const y1 = Math.min(peta.h - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const atas = peta.data[y0 * peta.w + x0] * (1 - ax) + peta.data[y0 * peta.w + x1] * ax;
    const bawah = peta.data[y1 * peta.w + x0] * (1 - ax) + peta.data[y1 * peta.w + x1] * ax;
    return atas * (1 - ay) + bawah * ay;
  }

  // ══ Filter warna ══════════════════════════════════════════════════════════
  /* Enam mode, satu urutan pikir yang sama:
       ratakan cahaya (buang bayangan) → atur kontras → pertajam / ambang.
     Yang membedakan hanyalah seberapa jauh tiap langkah didorong, dan apakah
     hasilnya disimpan sebagai gradasi atau dipaksa jadi dua warna. */
  function terapkanFilter(kanvas, hal) {
    const jenis = hal.filter;
    const ctx = kanvas.getContext('2d', { willReadFrequently: true });
    const gambar = ctx.getImageData(0, 0, kanvas.width, kanvas.height);
    const d = gambar.data;
    const w = kanvas.width;
    const h = kanvas.height;

    // Kenop "buang bayangan" mengubah seberapa keras cahaya diratakan. Di 0,
    // foto dibiarkan apa adanya — berguna untuk dokumen berlatar warna yang
    // justru rusak kalau latarnya dipaksa putih.
    const kuatBayangan = Math.max(0, Math.min(1, (hal.bayangan ?? 100) / 100));

    if (jenis === 'abu') {
      abukan(d);
      ratakanCahaya(d, w, h, 0.85 * kuatBayangan);
      regangKontras(d);
      tajamkan(d, w, h, 0.55);
    } else if (jenis === 'tingkatkan') {
      ratakanCahaya(d, w, h, kuatBayangan);
      regangKontras(d);
      tajamkan(d, w, h, 0.55);
    } else if (jenis === 'teks') {
      /* Jalan tengah antara abu-abu dan dua warna: latar dipaksa putih bersih,
         tinta dipekatkan, tapi tepi huruf tetap bergradasi. Teks 8 pt yang
         patah-patah bila diambang tetap terbaca di mode ini. */
      abukan(d);
      ratakanCahaya(d, w, h, kuatBayangan);
      regangKontras(d);
      kurvaTeks(d);
      tajamkan(d, w, h, 0.8);
    } else if (DUA_WARNA.includes(jenis)) {
      /* Pada mode dua warna, kenop kecerahan tidak menggeser piksel — piksel
         hanya hitam atau putih. Yang digeser adalah AMBANGNYA, sehingga
         tulisan jadi lebih tipis atau lebih tebal. */
      ambangAdaptif(d, w, h, -hal.cerah / 500);
      buangBintik(d, w, h);
      buangNodaTepi(d, w, h);
      if (jenis === 'hemat') {
        // Dua langkah penghemat: garis tebal dikikis satu piksel, lalu hitam
        // pekat diturunkan jadi abu. Keduanya mengurangi tinta yang menempel
        // tanpa membuat tulisan hilang.
        tipiskanTinta(d, w, h);
        pekatTinta(d, hal.tinta);
      }
    }

    if (!DUA_WARNA.includes(jenis)) aturCerahKontras(d, hal.cerah, hal.kontras);
    if (jenis !== 'asli') putihkanTepi(d, w, h, 0.006);

    ctx.putImageData(gambar, 0, 0);
    return kanvas;
  }

  function abukan(d) {
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
  }

  /* Kurva "teks tajam": semua yang lebih terang dari 195 dijadikan putih murni
     (kertas benar-benar bersih, tidak ada tinta terbuang untuk latar), dan yang
     lebih gelap dari 90 dijadikan hitam. Di antaranya direntang linear supaya
     tepi huruf tetap halus. */
  function kurvaTeks(d) {
    const bawah = 90;
    const atas = 195;
    const tabel = new Uint8Array(256);
    for (let v = 0; v < 256; v += 1) {
      tabel[v] = v <= bawah ? 0
        : v >= atas ? 255
          : (((v - bawah) * 255) / (atas - bawah)) | 0;
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = tabel[d[i]];
    }
  }

  /* Mengikis satu piksel dari tepi coretan yang TEBAL saja. Piksel hitam di
     tepi garis tipis (huruf kecil, garis tabel satu piksel) punya sedikit
     tetangga hitam dan sengaja dibiarkan — kalau ikut dikikis, tulisannya
     putus dan hasil "hemat" jadi tidak terbaca. */
  function tipiskanTinta(d, w, h) {
    const n = w * h;
    const hitam = new Uint8Array(n);
    for (let p = 0, t = 0; p < n; p += 1, t += 4) hitam[p] = d[t] < 128 ? 1 : 0;

    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const p = y * w + x;
        if (!hitam[p]) continue;
        const atas = hitam[p - w];
        const bawah = hitam[p + w];
        const kiri = hitam[p - 1];
        const kanan = hitam[p + 1];
        const diTepi = !(atas && bawah && kiri && kanan);
        if (!diTepi) continue;
        const tetangga = atas + bawah + kiri + kanan
          + hitam[p - w - 1] + hitam[p - w + 1] + hitam[p + w - 1] + hitam[p + w + 1];
        // 5 dari 8 tetangga hitam = coretan tebal; di bawah itu garisnya tipis.
        if (tetangga >= 5) {
          const t = p * 4;
          d[t] = d[t + 1] = d[t + 2] = 255;
        }
      }
    }
  }

  /* Menurunkan hitam pekat jadi abu. Printer laser mencetak abu sebagai raster
     titik yang lebih jarang, jadi tonernya benar-benar berkurang — bukan cuma
     terlihat lebih tipis. */
  function pekatTinta(d, kepekatan) {
    const nilai = Math.max(0, Math.min(255, Math.round(255 - (Math.max(0, Math.min(100, kepekatan ?? 62)) / 100) * 255)));
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 128) d[i] = d[i + 1] = d[i + 2] = nilai;
    }
  }

  /* Perkiraan kasar pemakaian tinta: rata-rata kegelapan seluruh halaman.
     Bukan angka teknis printer, tapi cukup untuk membandingkan antar filter —
     dan itulah yang ingin diketahui pengguna sebelum mencetak 50 lembar. */
  function perkiraanTinta(kanvas) {
    const K = 240;
    const skala = Math.min(1, K / Math.max(kanvas.width, kanvas.height));
    const w = Math.max(1, Math.round(kanvas.width * skala));
    const h = Math.max(1, Math.round(kanvas.height * skala));
    const kecil = document.createElement('canvas');
    kecil.width = w; kecil.height = h;
    kecil.getContext('2d').drawImage(kanvas, 0, 0, w, h);
    const d = kecil.getContext('2d').getImageData(0, 0, w, h).data;
    let jumlah = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      jumlah += (255 - g) / 255;
    }
    return jumlah / (w * h);
  }

  /* Membagi tiap piksel dengan terang kertas di sekitarnya. Bayangan tangan,
     lekuk buku, dan cahaya lampu yang miring hilang — kertas jadi putih rata
     tanpa menghapus tinta. Inilah pembeda terbesar antara "foto dokumen" dan
     "hasil scan". */
  function ratakanCahaya(d, w, h, kekuatan) {
    const peta = petaLatar(d, w, h, 0.18);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const latar = Math.max(40, nilaiLatar(peta, x, y, w, h));
        const f = 255 / latar;
        const t = (y * w + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          const asli = d[t + c];
          const rata = asli * f;
          d[t + c] = Math.max(0, Math.min(255, asli + (rata - asli) * kekuatan));
        }
      }
    }
  }

  function regangKontras(d) {
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < d.length; i += 4) {
      hist[0][d[i]] += 1; hist[1][d[i + 1]] += 1; hist[2][d[i + 2]] += 1;
    }
    const total = d.length / 4;
    const batasBawah = total * 0.005;
    const batasAtas = total * 0.99;
    const peta = [];
    for (let c = 0; c < 3; c += 1) {
      let kumulatif = 0; let lo = 0; let hi = 255;
      for (let v = 0; v < 256; v += 1) {
        kumulatif += hist[c][v];
        if (kumulatif >= batasBawah) { lo = v; break; }
      }
      kumulatif = 0;
      for (let v = 0; v < 256; v += 1) {
        kumulatif += hist[c][v];
        if (kumulatif >= batasAtas) { hi = v; break; }
      }
      const rentang = Math.max(1, hi - lo);
      const tabel = new Uint8Array(256);
      for (let v = 0; v < 256; v += 1) {
        tabel[v] = Math.max(0, Math.min(255, ((v - lo) * 255 / rentang) | 0));
      }
      peta.push(tabel);
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = peta[0][d[i]];
      d[i + 1] = peta[1][d[i + 1]];
      d[i + 2] = peta[2][d[i + 2]];
    }
  }

  /* Unsharp mask sederhana: kurangi versi buram dari versi asli. Kamera HP
     selalu menghasilkan tepi huruf yang agak lembut; tanpa ini, teks kecil
     terlihat berkabut begitu dicetak. Blur dipisah jadi dua lintasan 3-tap
     supaya tetap murah pada foto besar. */
  function tajamkan(d, w, h, kekuatan) {
    if (kekuatan <= 0) return;
    const n = w * h;
    const abu = new Uint8ClampedArray(n);
    for (let p = 0, t = 0; p < n; p += 1, t += 4) {
      abu[p] = (d[t] * 0.299 + d[t + 1] * 0.587 + d[t + 2] * 0.114) | 0;
    }
    const sementara = new Uint8ClampedArray(n);
    for (let y = 0; y < h; y += 1) {
      const b = y * w;
      for (let x = 0; x < w; x += 1) {
        const kiri = abu[b + (x > 0 ? x - 1 : 0)];
        const tengah = abu[b + x];
        const kanan = abu[b + (x < w - 1 ? x + 1 : w - 1)];
        sementara[b + x] = (kiri + tengah + kanan) / 3;
      }
    }
    const buram = new Uint8ClampedArray(n);
    for (let y = 0; y < h; y += 1) {
      const atas = (y > 0 ? y - 1 : 0) * w;
      const tengah = y * w;
      const bawah = (y < h - 1 ? y + 1 : h - 1) * w;
      for (let x = 0; x < w; x += 1) {
        buram[tengah + x] = (sementara[atas + x] + sementara[tengah + x] + sementara[bawah + x]) / 3;
      }
    }
    for (let p = 0, t = 0; p < n; p += 1, t += 4) {
      const beda = (abu[p] - buram[p]) * kekuatan;
      d[t] = Math.max(0, Math.min(255, d[t] + beda));
      d[t + 1] = Math.max(0, Math.min(255, d[t + 1] + beda));
      d[t + 2] = Math.max(0, Math.min(255, d[t + 2] + beda));
    }
  }

  /* Ambang adaptif: tiap piksel dibandingkan dengan terang kertas di sekitarnya,
     bukan satu ambang untuk seluruh gambar. Itulah yang membuat foto berbayang
     tetap menghasilkan teks hitam di atas kertas putih. */
  function ambangAdaptif(d, w, h, geser = 0) {
    const peta = petaLatar(d, w, h, 0.12);
    const beda = 0.86 + geser;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const t = (y * w + x) * 4;
        const abu = d[t] * 0.299 + d[t + 1] * 0.587 + d[t + 2] * 0.114;
        const latar = Math.max(30, nilaiLatar(peta, x, y, w, h));
        const nilai = abu < latar * beda ? 0 : 255;
        d[t] = d[t + 1] = d[t + 2] = nilai;
      }
    }
  }

  /* Membuang piksel hitam yang berdiri sendiri — debu kertas, noise sensor, dan
     bintik sisa ambang. Tanpa ini, area kosong hasil hitam-putih terlihat kotor
     dan boros tinta. */
  function buangBintik(d, w, h) {
    const n = w * h;
    const hitam = new Uint8Array(n);
    for (let p = 0, t = 0; p < n; p += 1, t += 4) hitam[p] = d[t] < 128 ? 1 : 0;
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const p = y * w + x;
        if (!hitam[p]) continue;
        const tetangga = hitam[p - 1] + hitam[p + 1] + hitam[p - w] + hitam[p + w]
          + hitam[p - w - 1] + hitam[p - w + 1] + hitam[p + w - 1] + hitam[p + w + 1];
        if (tetangga <= 1) {
          const t = p * 4;
          d[t] = d[t + 1] = d[t + 2] = 255;
        }
      }
    }
  }

  /* Membuang gumpalan hitam yang menempel di tepi hasil — sisa bayangan pekat
     atau permukaan meja yang ikut terbawa saat crop meleset sedikit.

     Yang dihapus HANYA gumpalan padat: luasnya besar dan hampir memenuhi kotak
     pembatasnya sendiri. Garis tabel, kop surat, dan tulisan yang kebetulan
     menyentuh tepi berbentuk tipis memanjang — rasio kepadatannya rendah, jadi
     tidak ikut terhapus. */
  function buangNodaTepi(d, w, h) {
    const n = w * h;
    const hitam = new Uint8Array(n);
    for (let p = 0, t = 0; p < n; p += 1, t += 4) hitam[p] = d[t] < 128 ? 1 : 0;

    const dilihat = new Uint8Array(n);
    const benih = [];
    for (let x = 0; x < w; x += 1) { benih.push(x); benih.push((h - 1) * w + x); }
    for (let y = 0; y < h; y += 1) { benih.push(y * w); benih.push(y * w + w - 1); }

    const luasMinimal = Math.max(60, n * 0.0002);
    const sisiMinimal = Math.max(3, Math.round(Math.min(w, h) * 0.025));
    const tumpuk = new Int32Array(Math.min(n, 1 << 21));

    for (const awal of benih) {
      if (!hitam[awal] || dilihat[awal]) continue;
      let atas = 0;
      tumpuk[atas] = awal;
      atas += 1;
      dilihat[awal] = 1;
      const anggota = [];
      let xMin = w; let xMaks = 0; let yMin = h; let yMaks = 0;

      while (atas > 0) {
        atas -= 1;
        const p = tumpuk[atas];
        anggota.push(p);
        const x = p % w;
        const y = (p / w) | 0;
        if (x < xMin) xMin = x;
        if (x > xMaks) xMaks = x;
        if (y < yMin) yMin = y;
        if (y > yMaks) yMaks = y;

        const dorong = (q) => {
          if (hitam[q] && !dilihat[q] && atas < tumpuk.length) {
            dilihat[q] = 1;
            tumpuk[atas] = q;
            atas += 1;
          }
        };
        if (x > 0) dorong(p - 1);
        if (x < w - 1) dorong(p + 1);
        if (y > 0) dorong(p - w);
        if (y < h - 1) dorong(p + w);
      }

      const lebarKotak = xMaks - xMin + 1;
      const tinggiKotak = yMaks - yMin + 1;
      const padat = anggota.length / Math.max(1, lebarKotak * tinggiKotak);
      // Gumpalan bayangan gemuk ke SEGALA arah. Garis tabel dan bingkai kop
      // surat juga padat, tapi salah satu sisinya selalu tipis — itu pembedanya.
      const gemuk = Math.min(lebarKotak, tinggiKotak) >= sisiMinimal;
      if (anggota.length >= luasMinimal && padat > 0.45 && gemuk) {
        for (const p of anggota) {
          const t = p * 4;
          d[t] = d[t + 1] = d[t + 2] = 255;
        }
      }
    }
  }

  /* Memutihkan bingkai paling luar hasil. Sisa garis meja atau bayangan tepi
     yang lolos dari crop akan tampil sebagai pita hitam pekat — jelek sekaligus
     memboroskan tinta. Lebarnya hanya ~1 mm pada A4, jauh di dalam batas yang
     memang tidak bisa dicetak printer mana pun, jadi tidak ada isi yang hilang. */
  function putihkanTepi(d, w, h, bagian) {
    const tebal = Math.max(2, Math.round(Math.min(w, h) * bagian));
    const putih = (x, y) => {
      const t = (y * w + x) * 4;
      d[t] = d[t + 1] = d[t + 2] = 255;
    };
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < tebal; x += 1) { putih(x, y); putih(w - 1 - x, y); }
    }
    for (let x = 0; x < w; x += 1) {
      for (let y = 0; y < tebal; y += 1) { putih(x, y); putih(x, h - 1 - y); }
    }
  }

  // Kenop manual, dipakai kalau hasil otomatis belum pas.
  function aturCerahKontras(d, cerah, kontras) {
    if (!cerah && !kontras) return;
    const c = 1 + (kontras || 0) / 100;
    const b = (cerah || 0) * 1.28;
    const tabel = new Uint8Array(256);
    for (let v = 0; v < 256; v += 1) {
      tabel[v] = Math.max(0, Math.min(255, ((v - 128) * c + 128 + b) | 0));
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = tabel[d[i]];
      d[i + 1] = tabel[d[i + 1]];
      d[i + 2] = tabel[d[i + 2]];
    }
  }

  function putar(kanvas, derajat) {
    if (!derajat) return kanvas;
    const balik = derajat === 90 || derajat === 270;
    const hasil = document.createElement('canvas');
    hasil.width = balik ? kanvas.height : kanvas.width;
    hasil.height = balik ? kanvas.width : kanvas.height;
    const ctx = hasil.getContext('2d');
    ctx.translate(hasil.width / 2, hasil.height / 2);
    ctx.rotate((derajat * Math.PI) / 180);
    ctx.drawImage(kanvas, -kanvas.width / 2, -kanvas.height / 2);
    return hasil;
  }

  // ══ Pemrosesan halaman ════════════════════════════════════════════════════
  // Pratinjau: cepat, dari gambar kerja yang kecil.
  async function prosesPratinjau(hal) {
    hal.diproses = false;
    await jeda(0);
    const lurus = luruskan(hal.kerja, hal.sudut, 900);
    // Pemakaian tinta foto mentah diukur sekali sebagai pembanding, supaya
    // penghematan tiap filter bisa dinyatakan dalam persen yang berarti.
    if (hal.tinta_asli == null) hal.tinta_asli = perkiraanTinta(lurus);
    let kanvas = terapkanFilter(lurus, hal);
    hal.tinta_pakai = perkiraanTinta(kanvas);
    kanvas = putar(kanvas, hal.rotasi);
    hal.kecil = kanvas.toDataURL('image/jpeg', 0.7);
    hal.diproses = true;
    return hal;
  }

  /** Kalimat perkiraan tinta untuk satu halaman — dipakai editor dan daftar. */
  function kalimatTinta(hal) {
    if (hal.tinta_pakai == null || !hal.tinta_asli) return '';
    const persen = Math.round(hal.tinta_pakai * 100);
    const hemat = Math.round((1 - hal.tinta_pakai / hal.tinta_asli) * 100);
    return hemat > 3
      ? `Perkiraan tinta: ${persen}% halaman — sekitar ${hemat}% lebih irit dari foto aslinya.`
      : `Perkiraan tinta: ${persen}% halaman.`;
  }

  // Hasil akhir: dari foto asli, pada resolusi penuh yang dipilih pengguna.
  async function prosesPenuh(hal) {
    await jeda(0);
    const batas = MUTU.find((m) => m.id === mutu).px;
    const sudutAsli = hal.sudut.map((p) => ({ x: p.x * hal.skala, y: p.y * hal.skala }));
    let kanvas = luruskan(hal.asli, sudutAsli, batas);
    kanvas = terapkanFilter(kanvas, hal);
    return putar(kanvas, hal.rotasi);
  }

  // Perkiraan ketajaman hasil bila dicetak di A4, untuk memperingatkan pengguna.
  function perkiraanDpi(hal) {
    const sudutAsli = hal.sudut.map((p) => ({ x: p.x * hal.skala, y: p.y * hal.skala }));
    const batas = MUTU.find((m) => m.id === mutu).px;
    const { w, h } = ukuranHasil(sudutAsli, batas);
    const sisiPanjangInci = 11.69;         // tinggi A4
    return Math.round(Math.max(w, h) / sisiPanjangInci);
  }

  // ══ Daftar halaman ════════════════════════════════════════════════════════
  function tampilDaftar() {
    /* Tampilan kamera dibuang lebih dulu.

       gambarDaftar() sengaja menolak menggambar selama elemen video masih ada —
       pengaman supaya pratinjau yang baru selesai diproses tidak menghapus
       jendela bidik saat pengguna masih memotret. Tanpa pembersihan di sini,
       pengaman itu ikut memblokir tombol "Selesai": kamera berhenti, tapi
       layarnya tidak pernah berganti ke daftar halaman. */
    hentikanKamera();
    const isi = $('#scanIsi', lapis);
    if (isi && $('#scanVideo', lapis)) isi.innerHTML = '';

    judul('Halaman Hasil Scan', 'Ketuk halaman untuk merapikan sudut atau ganti warnanya');
    gambarDaftar();
  }

  function gambarDaftar() {
    if (!lapis || $('#scanVideo', lapis)) return;
    const isi = $('#scanIsi', lapis);
    const dpiTerendah = halaman.length ? Math.min(...halaman.map(perkiraanDpi)) : 999;

    const tinta = ringkasTinta();

    isi.innerHTML = `
      ${halaman.length && dpiTerendah < DPI_MINIMAL ? `
        <div class="scan-ingat">
          Foto agak kurang tajam untuk dicetak (sekitar ${dpiTerendah} dpi).
          Coba potret ulang lebih dekat sampai dokumen memenuhi layar,
          atau naikkan Ketajaman ke <b>Maksimal</b> di bawah.
        </div>` : ''}
      ${catatanDaftar ? `<div class="scan-ingat" id="scanCatatan">${lolos(catatanDaftar)}</div>` : ''}
      ${tinta.boros ? `
        <div class="scan-ingat">
          Perkiraan pemakaian tinta halaman ini <b>${tinta.persen}%</b> — cukup boros.
          Ketuk halamannya lalu pilih filter <b>Hemat Tinta</b> atau <b>Hitam Putih</b>,
          dan tekan <b>Terapkan ke semua halaman</b>.
        </div>` : ''}
      <div class="scan-kisi" id="scanKisi">
        ${halaman.map((h, i) => `
          <div class="scan-hal" data-hal="${h.id}">
            ${h.kecil ? `<img src="${h.kecil}" alt="Halaman ${i + 1}">` : ''}
            <span class="nomor">${i + 1}</span>
            <button class="buang" data-buang="${h.id}" aria-label="Hapus halaman">×</button>
            <div class="scan-hal-alat">
              <button data-naik="${h.id}" ${i === 0 ? 'disabled' : ''} aria-label="Pindah ke atas">↑</button>
              <button data-putar="${h.id}" aria-label="Putar">↻</button>
              <button data-turun="${h.id}" ${i === halaman.length - 1 ? 'disabled' : ''} aria-label="Pindah ke bawah">↓</button>
            </div>
            ${h.diproses ? '' : '<div class="sedang">Merapikan…</div>'}
          </div>`).join('')}
        <button class="scan-tambah" id="scanTambah"><span>＋</span>Tambah halaman</button>
      </div>`;

    $$('.scan-hal', isi).forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('button')) return;
        const hal = halaman.find((h) => h.id === Number(el.dataset.hal));
        if (hal?.diproses) tampilEditor(hal);
      };
    });
    const cari = (id) => halaman.findIndex((h) => h.id === Number(id));
    $$('[data-buang]', isi).forEach((t) => {
      t.onclick = (e) => {
        e.stopPropagation();
        halaman.splice(cari(t.dataset.buang), 1);
        gambarDaftar();
      };
    });
    $$('[data-naik]', isi).forEach((t) => {
      t.onclick = (e) => {
        e.stopPropagation();
        const i = cari(t.dataset.naik);
        if (i > 0) { [halaman[i - 1], halaman[i]] = [halaman[i], halaman[i - 1]]; gambarDaftar(); }
      };
    });
    $$('[data-turun]', isi).forEach((t) => {
      t.onclick = (e) => {
        e.stopPropagation();
        const i = cari(t.dataset.turun);
        if (i < halaman.length - 1) { [halaman[i + 1], halaman[i]] = [halaman[i], halaman[i + 1]]; gambarDaftar(); }
      };
    });
    $$('[data-putar]', isi).forEach((t) => {
      t.onclick = async (e) => {
        e.stopPropagation();
        const hal = halaman[cari(t.dataset.putar)];
        hal.rotasi = (hal.rotasi + 90) % 360;
        gambarDaftar();
        await prosesPratinjau(hal);
        gambarDaftar();
      };
    });
    $('#scanTambah', isi).onclick = pilihanTambah;

    const semuaSiap = halaman.length > 0 && halaman.every((h) => h.diproses);
    $('#scanKaki', lapis).innerHTML = `
      <div class="scan-setelan">
        <label>Ketajaman
          <select id="scanMutu">
            ${MUTU.map((m) => `<option value="${m.id}" ${m.id === mutu ? 'selected' : ''}>${m.label} — ${m.ket}</option>`).join('')}
          </select>
        </label>
        <label>Ukuran kertas
          <select id="scanKertas">
            ${KERTAS.map((k) => `<option value="${k.id}" ${k.id === kertas ? 'selected' : ''}>${k.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="scan-kaki-baris">
        <span class="scan-label" style="flex:1;text-align:left;width:auto">
          ${halaman.length ? `${halaman.length} halaman siap` : 'Belum ada halaman'}
          ${tinta.persen != null ? `<br>Perkiraan tinta ${tinta.persen}%${tinta.hemat > 3 ? ` — ${tinta.hemat}% lebih irit dari foto asli` : ''}` : ''}
        </span>
        <button class="tombol netral kecil" id="scanTambah2">+ Tambah</button>
        <button class="tombol hijau" id="scanJadikan" ${semuaSiap ? '' : 'disabled'}>
          Buat PDF (${halaman.length})
        </button>
      </div>`;
    $('#scanTambah2', lapis).onclick = pilihanTambah;
    $('#scanJadikan', lapis).onclick = jadikanPdf;
    $('#scanMutu', lapis).onchange = (e) => { mutu = e.target.value; gambarDaftar(); };
    $('#scanKertas', lapis).onchange = (e) => { kertas = e.target.value; };
  }

  /* Rata-rata pemakaian tinta seluruh halaman. Dipakai untuk mengingatkan
     pengguna sebelum PDF dibuat — sesudah dicetak sudah terlambat. */
  function ringkasTinta() {
    const terukur = halaman.filter((h) => h.tinta_pakai != null && h.tinta_asli);
    if (!terukur.length) return { persen: null, hemat: 0, boros: false };
    const pakai = terukur.reduce((n, h) => n + h.tinta_pakai, 0) / terukur.length;
    const asli = terukur.reduce((n, h) => n + h.tinta_asli, 0) / terukur.length;
    const persen = Math.round(pakai * 100);
    return {
      persen,
      hemat: Math.round((1 - pakai / asli) * 100),
      // Di atas seperempat halaman tertutup tinta, cetakan teks biasa memang
      // ada yang salah — biasanya latar foto ikut terbawa.
      boros: persen >= 25,
    };
  }

  /* Menambah halaman. Dulu memakai confirm() dengan dua pilihan tersamar
     ("Batal" berarti galeri) — susunan yang membingungkan, dan tidak
     menyediakan jalur kamera bawaan sama sekali. */
  function pilihanTambah() {
    const isi = $('#scanIsi', lapis);
    judul('Tambah Halaman', 'Pilih cara mengambil halaman berikutnya');
    isi.innerHTML = `<div class="scan-galat">
      ${kameraLangsungTersedia()
    ? '<button class="tombol" id="tbKameraLangsung">📷 Kamera langsung (dengan panduan sudut)</button>'
    : ''}
      <button class="tombol ${kameraLangsungTersedia() ? 'netral' : ''}" id="tbKameraHp"
        style="margin-top:9px">📱 Kamera HP</button>
      <button class="tombol netral" id="tbGaleri" style="margin-top:9px">🖼️ Pilih dari galeri</button>
      <button class="tombol netral" id="tbBatalTambah" style="margin-top:9px">← Kembali</button>
    </div>`;
    if ($('#tbKameraLangsung', lapis)) $('#tbKameraLangsung', lapis).onclick = tampilKamera;
    $('#tbKameraHp', lapis).onclick = () => $('#scanInputKamera', lapis).click();
    $('#tbGaleri', lapis).onclick = () => $('#scanInputFoto', lapis).click();
    $('#tbBatalTambah', lapis).onclick = tampilDaftar;
  }

  // ══ Editor satu halaman ═══════════════════════════════════════════════════
  function tampilEditor(hal) {
    // Catatan di layar daftar sudah tidak relevan begitu satu halaman dibuka.
    catatanDaftar = '';
    judul(`Halaman ${halaman.indexOf(hal) + 1}`, 'Geser titik biru ke sudut dokumen');
    const isi = $('#scanIsi', lapis);

    const skala = Math.min(
      1,
      900 / Math.max(hal.kerja.width, hal.kerja.height),
      (window.innerWidth - 40) / hal.kerja.width,
    );
    const pw = Math.round(hal.kerja.width * skala);
    const ph = Math.round(hal.kerja.height * skala);

    isi.innerHTML = `
      <div class="scan-edit">
        <div class="scan-alat scan-alih" id="scanAlih">
          <button class="scan-chip aktif" data-tampil="sudut">✂️ Atur sudut</button>
          <button class="scan-chip" data-tampil="hasil">👁️ Hasil cetak</button>
        </div>

        <div class="scan-kanvas-bungkus" id="scanBungkus" style="width:${pw}px">
          <canvas id="scanPratinjau" width="${pw}" height="${ph}"></canvas>
          <canvas id="scanHasil" class="sembunyi"></canvas>
          <canvas id="scanKaca" class="scan-kaca sembunyi" width="132" height="132"></canvas>
          <div class="scan-olah sembunyi" id="scanOlah"><span class="pemuat"></span> Memproses…</div>
        </div>
        <div class="scan-label" id="scanKetTampil">Empat titik biru menandai tepi dokumen. Geser bila ada yang meleset.</div>

        <div class="scan-alat scan-zoom sembunyi" id="scanZoomBar">
          <button class="scan-chip" id="scanZoomKurang">−</button>
          <span class="scan-chip mati" id="scanZoomNilai">100%</span>
          <button class="scan-chip" id="scanZoomTambah">+</button>
          <button class="scan-chip" id="scanZoomPas">Pas layar</button>
        </div>

        <div class="scan-alat" id="scanFilter">
          ${FILTER.map((f) => `<button class="scan-chip ${hal.filter === f.id ? 'aktif' : ''}"
            data-filter="${f.id}" title="${lolos(f.ket)}">${lolos(f.label)}</button>`).join('')}
        </div>
        <div class="scan-label" id="scanKetFilter"></div>

        <div class="scan-geser">
          <label><span id="labelCerah">Kecerahan</span> <b id="nilaiCerah">${hal.cerah}</b>
            <input type="range" id="scanCerah" min="-60" max="60" step="5" value="${hal.cerah}">
          </label>
          <label id="barisKontras">Kontras <b id="nilaiKontras">${hal.kontras}</b>
            <input type="range" id="scanKontras" min="-50" max="60" step="5" value="${hal.kontras}">
          </label>
          <label id="barisBayangan">Buang bayangan <b id="nilaiBayangan">${hal.bayangan}%</b>
            <input type="range" id="scanBayangan" min="0" max="100" step="10" value="${hal.bayangan}">
          </label>
          <label id="barisTinta">Kepekatan tinta <b id="nilaiTinta">${hal.tinta}%</b>
            <input type="range" id="scanTinta" min="25" max="100" step="5" value="${hal.tinta}">
          </label>
          <button class="scan-chip" id="scanReset">Kembalikan otomatis</button>
        </div>

        <div class="scan-alat">
          <button class="scan-chip" id="scanBatal" disabled>↶ Batal</button>
          <button class="scan-chip" id="scanPutarKiri">↺ Putar kiri</button>
          <button class="scan-chip" id="scanPutarKanan">↻ Putar kanan</button>
          <button class="scan-chip" id="scanSudutPenuh">Pakai seluruh foto</button>
          <button class="scan-chip" id="scanSudutOtomatis">Deteksi ulang</button>
          <button class="scan-chip" id="scanPisah">📖 Pisah jadi 2 halaman</button>
          <button class="scan-chip" id="scanSemua">Terapkan ke semua halaman</button>
        </div>
        <div class="scan-label" id="scanTinta_ket">${lolos(kalimatTinta(hal))}</div>
        <div class="scan-label" id="scanDpi"></div>
      </div>`;

    const kanvas = $('#scanPratinjau', isi);
    const ctx = kanvas.getContext('2d');
    const bungkus = $('#scanBungkus', isi);

    const perbaruiDpi = () => {
      const dpi = perkiraanDpi(hal);
      $('#scanDpi', isi).innerHTML = dpi < DPI_MINIMAL
        ? `<span style="color:#fca5a5">Perkiraan ketajaman cetak: ${dpi} dpi — agak kabur, coba potret lebih dekat.</span>`
        : `Perkiraan ketajaman cetak: ${dpi} dpi — cukup untuk dicetak.`;
    };

    function gambarUlang() {
      ctx.clearRect(0, 0, pw, ph);
      ctx.drawImage(hal.kerja, 0, 0, pw, ph);
      ctx.save();
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(37, 99, 235, .14)';
      ctx.beginPath();
      hal.sudut.forEach((p, i) => {
        const x = p.x * skala;
        const y = p.y * skala;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      $$('.scan-titik', bungkus).forEach((t, i) => {
        t.style.left = `${hal.sudut[i].x * skala}px`;
        t.style.top = `${hal.sudut[i].y * skala}px`;
      });
      perbaruiDpi();
    }

    /* Kaca pembesar.

       Di layar sentuh, jari MENUTUPI titik yang sedang ditaruh — pengguna
       menempatkan sudut sambil menebak. Kaca ini menampilkan potongan foto di
       bawah jari, diperbesar, di sisi yang berlawanan dari jari itu sendiri. */
    const kaca = $('#scanKaca', isi);
    const ctxKaca = kaca.getContext('2d');
    const ZOOM_KACA = 3.2;

    function tampilKaca(xKerja, yKerja, xLayar, yLayar) {
      const sisi = kaca.width;
      const sumber = sisi / ZOOM_KACA;
      ctxKaca.fillStyle = '#0f172a';
      ctxKaca.fillRect(0, 0, sisi, sisi);
      ctxKaca.imageSmoothingEnabled = false;
      ctxKaca.drawImage(hal.kerja,
        xKerja - sumber / 2, yKerja - sumber / 2, sumber, sumber,
        0, 0, sisi, sisi);

      // Bidik silang supaya titik tepatnya terlihat, bukan cuma daerahnya.
      ctxKaca.strokeStyle = 'rgba(96,165,250,.95)';
      ctxKaca.lineWidth = 1.5;
      ctxKaca.beginPath();
      ctxKaca.moveTo(sisi / 2, sisi / 2 - 14); ctxKaca.lineTo(sisi / 2, sisi / 2 + 14);
      ctxKaca.moveTo(sisi / 2 - 14, sisi / 2); ctxKaca.lineTo(sisi / 2 + 14, sisi / 2);
      ctxKaca.stroke();
      ctxKaca.strokeStyle = 'rgba(96,165,250,.55)';
      ctxKaca.beginPath();
      ctxKaca.arc(sisi / 2, sisi / 2, 10, 0, Math.PI * 2);
      ctxKaca.stroke();

      /* Kaca ditaruh berseberangan dengan jari: kalau titiknya di bagian atas
         kanvas, kaca turun ke bawah, dan sebaliknya. Kalau tidak, kaca justru
         menutupi apa yang mau dilihat. */
      const diAtas = yLayar > kaca.height + 24;
      kaca.style.top = `${diAtas ? yLayar - kaca.height - 20 : yLayar + 20}px`;
      kaca.style.left = `${Math.max(4, Math.min(pw - kaca.width - 4, xLayar - kaca.width / 2))}px`;
      kaca.classList.remove('sembunyi');
    }

    function sembunyikanKaca() {
      kaca.classList.add('sembunyi');
    }

    hal.sudut.forEach((_, i) => {
      const titik = document.createElement('div');
      titik.className = 'scan-titik';
      titik.dataset.titik = i;
      bungkus.appendChild(titik);

      const mulai = (ev) => {
        ev.preventDefault();
        simpanRiwayat();
        const geser = (e) => {
          const sentuh = e.touches ? e.touches[0] : e;
          const kotak = kanvas.getBoundingClientRect();
          const x = Math.max(0, Math.min(hal.kerja.width, (sentuh.clientX - kotak.left) / kotak.width * hal.kerja.width));
          const y = Math.max(0, Math.min(hal.kerja.height, (sentuh.clientY - kotak.top) / kotak.height * hal.kerja.height));
          hal.sudut[i] = { x, y };
          sudutBerubah = true;
          gambarUlang();
          tampilKaca(x, y, x * skala, y * skala);
        };
        const lepas = () => {
          sembunyikanKaca();
          document.removeEventListener('mousemove', geser);
          document.removeEventListener('touchmove', geser);
          document.removeEventListener('mouseup', lepas);
          document.removeEventListener('touchend', lepas);
        };
        document.addEventListener('mousemove', geser);
        document.addEventListener('touchmove', geser, { passive: false });
        document.addEventListener('mouseup', lepas);
        document.addEventListener('touchend', lepas);
        geser(ev);
      };
      titik.addEventListener('mousedown', mulai);
      titik.addEventListener('touchstart', mulai, { passive: false });
    });

    /* Pratinjau hasil sungguhan.

       Sebelumnya kanvas editor hanya menampilkan FOTO ASLI beserta garis
       sudutnya; hasil olahan baru terlihat sebagai gambar kecil setelah
       menekan "Terapkan". Artinya pengguna memilih filter dan menggeser kenop
       tanpa melihat akibatnya — lalu baru tahu hasilnya keliru setelah kembali
       ke daftar. Di sini hasilnya bisa dilihat langsung, sebesar kanvas editor,
       dan ikut berubah tiap kali filter atau kenop digeser. */
    let tampil = 'sudut';
    const kanvasHasil = $('#scanHasil', isi);
    const ctxHasil = kanvasHasil.getContext('2d');

    /* Perbesaran pada pratinjau hasil.

       Alasannya praktis: yang menentukan layak-tidaknya sebuah scan dicetak
       adalah apakah TEKS KECILNYA masih terbaca — dan itu mustahil dinilai dari
       gambar selebar layar HP. Tanpa ini, pengguna baru tahu hasilnya kabur
       setelah lima puluh lembar keluar dari printer. */
    let gambarSiap = null;
    let zoom = 1;
    let geserX = 0;
    let geserY = 0;

    function batasiGeseran() {
      if (!gambarSiap) return;
      const lebihX = Math.max(0, (kanvasHasil.width * zoom - kanvasHasil.width) / 2);
      const lebihY = Math.max(0, (kanvasHasil.height * zoom - kanvasHasil.height) / 2);
      geserX = Math.max(-lebihX, Math.min(lebihX, geserX));
      geserY = Math.max(-lebihY, Math.min(lebihY, geserY));
    }

    function lukisHasil() {
      if (!gambarSiap) return;
      const w = kanvasHasil.width;
      const h = kanvasHasil.height;
      batasiGeseran();
      ctxHasil.setTransform(1, 0, 0, 1, 0, 0);
      ctxHasil.fillStyle = '#fff';
      ctxHasil.fillRect(0, 0, w, h);
      ctxHasil.save();
      ctxHasil.translate(w / 2 + geserX, h / 2 + geserY);
      ctxHasil.scale(zoom, zoom);
      // Piksel dibiarkan tajam saat diperbesar: yang mau dinilai justru
      // ketajaman aslinya, bukan hasil pelembutan peramban.
      ctxHasil.imageSmoothingEnabled = zoom < 1.5;
      ctxHasil.drawImage(gambarSiap, -w / 2, -h / 2, w, h);
      ctxHasil.restore();
      const tampilZoom = $('#scanZoomNilai', isi);
      if (tampilZoom) tampilZoom.textContent = `${Math.round(zoom * 100)}%`;
      kanvasHasil.style.cursor = zoom > 1 ? 'grab' : 'zoom-in';
    }

    function aturZoom(baru, pusatX, pusatY) {
      const lama = zoom;
      zoom = Math.max(1, Math.min(6, baru));
      if (zoom === 1) { geserX = 0; geserY = 0; } else if (pusatX != null) {
        // Titik yang ditunjuk tetap berada di tempatnya saat diperbesar.
        const rasio = zoom / lama;
        geserX = (geserX - pusatX) * rasio + pusatX;
        geserY = (geserY - pusatY) * rasio + pusatY;
      }
      lukisHasil();
    }

    function gambarHasil() {
      if (!hal.kecil) return;
      const img = new Image();
      img.onload = () => {
        // Ukuran mengikuti bentuk hasil (yang sudah diluruskan dan mungkin
        // diputar), bukan bentuk foto aslinya.
        const muat = Math.min(pw / img.width, (ph * 1.15) / img.height, 1.6);
        kanvasHasil.width = Math.max(1, Math.round(img.width * muat));
        kanvasHasil.height = Math.max(1, Math.round(img.height * muat));
        gambarSiap = img;
        lukisHasil();
      };
      img.src = hal.kecil;
    }

    // ── Kendali perbesaran ──────────────────────────────────────────────────
    kanvasHasil.addEventListener('wheel', (e) => {
      e.preventDefault();
      const kotak = kanvasHasil.getBoundingClientRect();
      const px = e.clientX - kotak.left - kotak.width / 2;
      const py = e.clientY - kotak.top - kotak.height / 2;
      aturZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), px, py);
    }, { passive: false });

    kanvasHasil.addEventListener('dblclick', (e) => {
      const kotak = kanvasHasil.getBoundingClientRect();
      const px = e.clientX - kotak.left - kotak.width / 2;
      const py = e.clientY - kotak.top - kotak.height / 2;
      aturZoom(zoom > 1 ? 1 : 3, px, py);
    });

    // Menggeser gambar saat sedang diperbesar, dengan tetikus maupun jari.
    let seret = null;
    const mulaiSeret = (e) => {
      if (zoom <= 1) return;
      const t = e.touches ? e.touches[0] : e;
      seret = { x: t.clientX, y: t.clientY, gx: geserX, gy: geserY };
      kanvasHasil.style.cursor = 'grabbing';
    };
    const jalanSeret = (e) => {
      if (!seret) return;
      e.preventDefault();
      const t = e.touches ? e.touches[0] : e;
      geserX = seret.gx + (t.clientX - seret.x);
      geserY = seret.gy + (t.clientY - seret.y);
      lukisHasil();
    };
    const selesaiSeret = () => { seret = null; if (zoom > 1) kanvasHasil.style.cursor = 'grab'; };
    kanvasHasil.addEventListener('mousedown', mulaiSeret);
    kanvasHasil.addEventListener('touchstart', mulaiSeret, { passive: true });
    document.addEventListener('mousemove', jalanSeret);
    document.addEventListener('touchmove', jalanSeret, { passive: false });
    document.addEventListener('mouseup', selesaiSeret);
    document.addEventListener('touchend', selesaiSeret);

    /* Dua jari untuk memperbesar — gerak yang paling dicari orang di layar
       sentuh, dan tanpa ini tombol +/− terasa seperti langkah mundur. */
    let jarakAwal = 0;
    let zoomAwal = 1;
    kanvasHasil.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      jarakAwal = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      zoomAwal = zoom;
    }, { passive: true });
    kanvasHasil.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !jarakAwal) return;
      e.preventDefault();
      const jarak = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      aturZoom(zoomAwal * (jarak / jarakAwal));
    }, { passive: false });
    kanvasHasil.addEventListener('touchend', (e) => { if (e.touches.length < 2) jarakAwal = 0; });

    function pindahTampilan(ke) {
      tampil = ke;
      const lihatHasil = ke === 'hasil';
      kanvas.classList.toggle('sembunyi', lihatHasil);
      kanvasHasil.classList.toggle('sembunyi', !lihatHasil);
      // Titik sudut ikut disembunyikan: menggesernya di atas gambar hasil tidak
      // ada artinya, dan hanya menutupi apa yang sedang diperiksa.
      $$('.scan-titik', bungkus).forEach((t) => t.classList.toggle('sembunyi', lihatHasil));
      if (lihatHasil) sembunyikanKaca();
      $('#scanZoomBar', isi).classList.toggle('sembunyi', !lihatHasil);
      $$('[data-tampil]', isi).forEach((b) => b.classList.toggle('aktif', b.dataset.tampil === ke));
      $('#scanKetTampil', isi).textContent = lihatHasil
        ? 'Beginilah halaman ini akan dicetak. Perbesar untuk memastikan teks kecilnya masih terbaca.'
        : 'Empat titik biru menandai tepi dokumen. Geser bila ada yang meleset.';
      if (lihatHasil) {
        if (sudutBerubah) segarkanSekarang(); else gambarHasil();
      }
    }

    // Sudut yang digeser membuat hasil lama basi; diproses ulang saat dilihat.
    let sudutBerubah = false;

    /* Riwayat posisi sudut. Menggeser empat titik di layar kecil mudah meleset,
       dan sebelum ini satu-satunya jalan pulih adalah "Deteksi ulang" — yang
       membuang SEMUA penyesuaian, bukan hanya yang barusan. */
    const riwayat = [];
    function simpanRiwayat() {
      riwayat.push(hal.sudut.map((t) => ({ ...t })));
      if (riwayat.length > 20) riwayat.shift();
      const tb = $('#scanBatal', isi);
      if (tb) tb.disabled = false;
    }
    function batalkanSatu() {
      const sebelum = riwayat.pop();
      if (!sebelum) return;
      hal.sudut = sebelum;
      sudutBerubah = true;
      gambarUlang();
      if (tampil === 'hasil') segarkanSekarang();
      const tb = $('#scanBatal', isi);
      if (tb) tb.disabled = riwayat.length === 0;
    }

    async function segarkanSekarang() {
      $('#scanOlah', isi)?.classList.remove('sembunyi');
      await prosesPratinjau(hal);
      sudutBerubah = false;
      $('#scanOlah', isi)?.classList.add('sembunyi');
      const ket = $('#scanTinta_ket', isi);
      if (ket) ket.textContent = kalimatTinta(hal);
      if (tampil === 'hasil') gambarHasil();
    }

    $$('[data-tampil]', isi).forEach((b) => {
      b.onclick = () => pindahTampilan(b.dataset.tampil);
    });
    $('#scanZoomTambah', isi).onclick = () => aturZoom(zoom * 1.5);
    $('#scanZoomKurang', isi).onclick = () => aturZoom(zoom / 1.5);
    $('#scanZoomPas', isi).onclick = () => aturZoom(1);

    const ketFilter = () => {
      const f = FILTER.find((x) => x.id === hal.filter);
      $('#scanKetFilter', isi).textContent = f ? f.ket : '';
      // Kenop yang tidak berarti apa-apa untuk mode ini disembunyikan saja,
      // daripada tampak bisa digeser tapi tidak mengubah hasil.
      const duaWarna = DUA_WARNA.includes(hal.filter);
      $('#labelCerah', isi).textContent = duaWarna ? 'Ketebalan tulisan' : 'Kecerahan';
      $('#barisKontras', isi).classList.toggle('sembunyi', duaWarna);
      // Mode dua warna sudah membuang bayangan lewat ambang adaptif; kenopnya
      // tidak dipakai di sana. Mode "Asli" memang tidak mengubah apa pun.
      $('#barisBayangan', isi).classList.toggle('sembunyi', duaWarna || hal.filter === 'asli');
      $('#barisTinta', isi).classList.toggle('sembunyi', hal.filter !== 'hemat');
    };
    ketFilter();
    gambarUlang();
    gambarHasil();

    /* Pratinjau kecil dihitung ulang setelah kenop berhenti digeser. Menunggu
       sebentar jauh lebih enak dipakai daripada memproses tiap langkah geseran
       — di HP kelas menengah, satu proses penuh butuh ratusan milidetik. */
    let jamPratinjau = null;
    const segarkanNanti = () => {
      clearTimeout(jamPratinjau);
      jamPratinjau = setTimeout(segarkanSekarang, 320);
    };

    $$('[data-filter]', isi).forEach((t) => {
      t.onclick = () => {
        hal.filter = t.dataset.filter;
        filterBawaan = hal.filter;
        $$('[data-filter]', isi).forEach((x) => x.classList.toggle('aktif', x === t));
        ketFilter();
        segarkanNanti();
      };
    });
    $('#scanBayangan', isi).oninput = (e) => {
      hal.bayangan = Number(e.target.value);
      $('#nilaiBayangan', isi).textContent = `${hal.bayangan}%`;
      segarkanNanti();
    };
    $('#scanTinta', isi).oninput = (e) => {
      hal.tinta = Number(e.target.value);
      $('#nilaiTinta', isi).textContent = `${hal.tinta}%`;
      segarkanNanti();
    };
    /* Foto buku terbuka berisi DUA halaman dalam satu gambar. Tanpa ini,
       pelanggan yang memotret buku mendapat cetakan dua halaman berdempetan di
       satu lembar — mengecil, boros kertas, dan sering tidak terbaca. */
    $('#scanPisah', isi).onclick = async (e) => {
      const tombol = e.target;
      tombol.disabled = true;
      tombol.textContent = 'Memisah…';
      try {
        const hasil = await pisahDuaHalaman(hal);
        catatanDaftar = hasil.meyakinkan
          ? `Halaman dipisah di lipatan bukunya (${Math.round(hasil.proporsi * 100)}% dari kiri). `
            + 'Ketuk salah satunya bila tepinya masih perlu dirapikan.'
          : 'Lipatan bukunya tidak terlihat jelas, jadi halaman dibelah tepat di tengah. '
            + 'Kalau meleset, ketuk tiap halaman lalu geser sudutnya.';
        tampilDaftar();
      } catch (galat) {
        tombol.disabled = false;
        tombol.textContent = '📖 Pisah jadi 2 halaman';
        catatanDaftar = `Gagal memisah halaman: ${galat.message}`;
        tampilDaftar();
      }
    };

    /* Menyalin pengaturan warna halaman ini ke semua halaman lain. Sudut TIDAK
       ikut disalin — tiap foto punya posisi kertasnya sendiri. */
    $('#scanSemua', isi).onclick = async (e) => {
      const tombol = e.target;
      tombol.disabled = true;
      tombol.textContent = 'Menerapkan…';
      for (const lain of halaman) {
        if (lain === hal) continue;
        lain.filter = hal.filter;
        lain.cerah = hal.cerah;
        lain.kontras = hal.kontras;
        lain.bayangan = hal.bayangan;
        lain.tinta = hal.tinta;
        await prosesPratinjau(lain);
      }
      tombol.textContent = `✓ Diterapkan ke ${halaman.length} halaman`;
      setTimeout(() => {
        tombol.disabled = false;
        tombol.textContent = 'Terapkan ke semua halaman';
      }, 2000);
    };
    $('#scanCerah', isi).oninput = (e) => {
      hal.cerah = Number(e.target.value);
      $('#nilaiCerah', isi).textContent = hal.cerah;
      segarkanNanti();
    };
    $('#scanKontras', isi).oninput = (e) => {
      hal.kontras = Number(e.target.value);
      $('#nilaiKontras', isi).textContent = hal.kontras;
      segarkanNanti();
    };
    $('#scanReset', isi).onclick = () => {
      hal.cerah = 0; hal.kontras = 0; hal.bayangan = 100; hal.tinta = 62;
      $('#scanCerah', isi).value = 0; $('#nilaiCerah', isi).textContent = '0';
      $('#scanKontras', isi).value = 0; $('#nilaiKontras', isi).textContent = '0';
      $('#scanBayangan', isi).value = 100; $('#nilaiBayangan', isi).textContent = '100%';
      $('#scanTinta', isi).value = 62; $('#nilaiTinta', isi).textContent = '62%';
      segarkanNanti();
    };
    $('#scanPutarKiri', isi).onclick = () => { hal.rotasi = (hal.rotasi + 270) % 360; segarkanNanti(); };
    $('#scanPutarKanan', isi).onclick = () => { hal.rotasi = (hal.rotasi + 90) % 360; segarkanNanti(); };
    $('#scanBatal', isi).onclick = batalkanSatu;
    $('#scanSudutPenuh', isi).onclick = () => {
      simpanRiwayat();
      hal.sudut = [
        { x: 0, y: 0 }, { x: hal.kerja.width, y: 0 },
        { x: hal.kerja.width, y: hal.kerja.height }, { x: 0, y: hal.kerja.height },
      ];
      sudutBerubah = true;
      gambarUlang();
      if (tampil === 'hasil') segarkanSekarang();
    };
    $('#scanSudutOtomatis', isi).onclick = () => {
      simpanRiwayat();
      hal.sudut = cariSudutDokumen(hal.kerja);
      sudutBerubah = true;
      gambarUlang();
      if (tampil === 'hasil') segarkanSekarang();
    };

    $('#scanKaki', lapis).innerHTML = `
      <div class="scan-kaki-baris">
        <button class="tombol netral kecil" id="scanBatalEdit">← Kembali</button>
        <button class="tombol" id="scanSimpanEdit" style="margin-left:auto">Terapkan</button>
      </div>`;
    $('#scanBatalEdit', lapis).onclick = tampilDaftar;
    $('#scanSimpanEdit', lapis).onclick = async () => {
      const tombol = $('#scanSimpanEdit', lapis);
      tombol.disabled = true;
      tombol.innerHTML = '<span class="pemuat"></span> Memproses…';
      await prosesPratinjau(hal);
      tampilDaftar();
    };
  }

  // ══ Gabung jadi PDF ═══════════════════════════════════════════════════════
  /* Mode cepat: tunggu semua halaman selesai dirapikan, lalu langsung buat PDF. */
  async function siapLaluPdf() {
    for (let i = 0; i < 600 && lapis && halaman.some((h) => !h.diproses); i += 1) await jeda(100);
    if (!lapis || !halaman.length) return;
    gambarDaftar();
    await jadikanPdf();
  }

  /* Buka lagi halaman hasil pindai terakhir dalam mode lengkap (geser sudut,
     ganti filter, putar, susun ulang) — dipakai tombol "Edit pages". */
  function ubah(opsi = {}) {
    if (!simpananCepat || !simpananCepat.length) return buka(opsi);
    selesaiCb = opsi.selesai || (() => {});
    modeCepat = false;
    buatLapis();
    halaman = simpananCepat.slice();
    nomorHal = Math.max(...halaman.map((h) => h.id));
    tampilDaftar();
  }

  async function jadikanPdf() {
    if (!halaman.length) return;
    const tombol = $('#scanJadikan', lapis);
    tombol.disabled = true;

    const majukan = (n) => {
      tombol.innerHTML = `<span class="pemuat"></span> Halaman ${n}/${halaman.length}…`;
    };

    try {
      const dok = await PDFLib.PDFDocument.create();

      for (let i = 0; i < halaman.length; i += 1) {
        const hal = halaman[i];
        majukan(i + 1);
        const jadi = await prosesPenuh(hal);

        /* Mode dua warna disimpan sebagai PNG: gambar dua warna terkompresi
           jauh lebih kecil dari JPEG DAN bebas dari bayangan artefak di
           sekitar huruf. Mode lain tetap JPEG karena isinya bergradasi. */
        const pakaiPng = DUA_WARNA.includes(hal.filter);
        const blob = await new Promise((r) => (pakaiPng
          ? jadi.toBlob(r, 'image/png')
          : jadi.toBlob(r, 'image/jpeg', MUTU_JPEG)));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const gambar = pakaiPng ? await dok.embedPng(bytes) : await dok.embedJpg(bytes);

        const pilihan = KERTAS.find((k) => k.id === kertas);
        let lembar;
        if (pilihan.id === 'auto') {
          // Halaman PDF mengikuti bentuk dokumen — tanpa margin terbuang.
          const skalaPt = 72 / 150;   // anggap 150 dpi supaya ukuran fisiknya wajar
          lembar = dok.addPage([gambar.width * skalaPt, gambar.height * skalaPt]);
          lembar.drawImage(gambar, { x: 0, y: 0, width: lembar.getWidth(), height: lembar.getHeight() });
        } else {
          // Kertas mengikuti orientasi dokumen supaya tidak ada ruang terbuang.
          const tegak = gambar.height >= gambar.width;
          const kertasW = tegak ? pilihan.w : pilihan.h;
          const kertasH = tegak ? pilihan.h : pilihan.w;
          const margin = 10;
          const muat = Math.min(
            (kertasW - margin * 2) / gambar.width,
            (kertasH - margin * 2) / gambar.height,
          );
          const w = gambar.width * muat;
          const h = gambar.height * muat;
          lembar = dok.addPage([kertasW, kertasH]);
          lembar.drawImage(gambar, { x: (kertasW - w) / 2, y: (kertasH - h) / 2, width: w, height: h });
        }
      }

      tombol.innerHTML = '<span class="pemuat"></span> Menyusun PDF…';
      const bytes = await dok.save();
      const stempel = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
      const berkas = new File([bytes], `Scan-${stempel}.pdf`, { type: 'application/pdf' });

      document.body.style.overflow = '';
      const kirim = selesaiCb;
      simpananCepat = halaman.slice();
      tutup();
      kirim(berkas);
    } catch (e) {
      tombol.disabled = false;
      tombol.textContent = `Buat PDF (${halaman.length})`;
      // Sama seperti pesan pisah halaman: ditampilkan di dalam layar, tidak
      // lewat kotak peramban yang memblokir semuanya.
      catatanDaftar = `Gagal membuat PDF: ${e.message}`;
      gambarDaftar();
    }
  }

  // Fungsi matematika diekspor agar bisa diuji oleh test.js di luar peramban.
  return {
    buka,
    ubah,
    tutup,
    _uji: {
      homografi, selesaikan, otsu, ukuranHasil, luasSegiempat, komponenTerbesar,
      petaLatar, nilaiLatar, buangBintik, aturCerahKontras, tajamkan,
      susutkan, putihkanTepi, buangNodaTepi,
      kurvaTeks, tipiskanTinta, pekatTinta, abukan, FILTER, DUA_WARNA,
      cariLipatan, tutupCelahTegak,
    },
  };
})();
