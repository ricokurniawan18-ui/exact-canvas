/* Notifikasi Web Push di perangkat ini: pengingat les, dipanggil ke meja guru,
 * pertanyaan dibahas (murid), dan ringkasan les harian (guru). Server Canvas
 * di Mac yang mengirim — lihat src-tauri/src/push.rs. */

type Api = <T>(path: string, init?: { method?: string; json?: unknown }) => Promise<T>

export type StatusPush = 'aktif' | 'belum' | 'ditolak' | 'tidak-didukung'

/** iPhone hanya mendukung push untuk aplikasi yang dipasang di layar utama. */
export function pushDidukung(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext
}

export function statusIzin(): StatusPush {
  if (!pushDidukung()) return 'tidak-didukung'
  if (Notification.permission === 'denied') return 'ditolak'
  return Notification.permission === 'granted' ? 'aktif' : 'belum'
}

function keBita(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const mentah = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(mentah, (c) => c.charCodeAt(0))
}

/**
 * Daftarkan perangkat ini. `minta` = boleh memunculkan dialog izin (harus dari
 * ketukan pengguna); tanpa itu hanya memperbarui pendaftaran yang sudah diizinkan
 * — dipanggil tiap kali halaman dibuka supaya server tahu HP ini milik siapa.
 */
export async function aktifkanPush(api: Api, peran: 'murid' | 'guru', murid: string | null, minta: boolean): Promise<StatusPush> {
  if (!pushDidukung()) return 'tidak-didukung'
  if (Notification.permission === 'denied') return 'ditolak'
  if (Notification.permission === 'default' && !minta) return 'belum'
  const reg = await navigator.serviceWorker.register('/sw.js')
  if (Notification.permission === 'default') {
    const izin = await Notification.requestPermission()
    if (izin !== 'granted') return izin === 'denied' ? 'ditolak' : 'belum'
  }
  await navigator.serviceWorker.ready
  const { kunci } = await api<{ kunci: string }>('/api/push/kunci')
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keBita(kunci) as BufferSource })
  }
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  await api('/api/push/daftar', {
    method: 'POST',
    json: { peran, murid, endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth },
  })
  return 'aktif'
}

export async function matikanPush(api: Api): Promise<void> {
  if (!pushDidukung()) return
  const reg = await navigator.serviceWorker.getRegistration('/sw.js')
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await api('/api/push/hapus', { method: 'POST', json: { endpoint: sub.endpoint } }).catch(() => undefined)
  await sub.unsubscribe()
}
