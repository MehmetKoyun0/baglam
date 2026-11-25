# Bağlam

**Yapay zekâ kodlama ajanları için ortak, insan onaylı proje hafızası ve ajanlar arası kesintisiz devir.**

> Ajanının tokenı mı bitti? Sıradaki, kaldığı yerden devam etsin.

[English](README.md)

Pazartesi Claude Code, salı Cursor, çarşamba Codex kullanıyorsun ve aynı kararları her birine yeniden anlatıyorsun. Bağlam, bütün ajanlarına her proje için tek bir ortak hafıza verir. O hafızaya neyin gireceğine sen karar verirsin.

```
 ajan bir şey öğrenir ──► önerir ──► sen onaylarsın ──► bütün ajanlar bilir
  (hangi araç olursa)    context_propose   baglam ui      context_brief
```

- **Zaten kullandığın araçlarla çalışır:** Claude Code, Codex CLI, Antigravity, Gemini CLI, Cursor, Windsurf, VS Code (MCP destekleyen her araç).
- **Kontrol sende:** Bir ajanın yazdığı hiçbir şey, sen onaylamadan (ya da senin kurduğun bir güven kuralı izin vermeden) diğer ajanlara ulaşmaz.
- **Varsayılan olarak güvenli:** Gizli bilgiler engellenir, birbirine benzeyen kayıtlar işaretlenir, hiçbir ajan onay kuyruğunu dolduramaz.
- **Yerel:** Bilgisayarında tek bir SQLite dosyası. Hesap yok, bulut yok, veri toplama yok.

## Kurulum

Node.js 22.13 veya üstü gerekir.

```bash
npm i -g baglam
baglam setup
```

`setup` bilgisayarındaki yapay zekâ araçlarını bulur, neyi değiştireceğini gösterir ve bir kez sorar. Dokunduğu her dosyanın önce yedeğini alır (`*.baglam-backup`). `baglam setup --undo` her şeyi geri alır. Sonra araçlarını yeniden başlat.

Ardından her proje klasöründe:

```bash
cd projem
baglam init
```

`init`, klasöre kalıcı bir proje kimliği verir (`.baglam/project.json`, git'e eklemek iyi olur). Ayrıca `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/baglam.mdc`, `.github/copilot-instructions.md` ve `.windsurf/rules/baglam.md` dosyalarına, kurulu araçlara göre kısa bir talimat ekler. Böylece ajanlar, sen söylemeden her görevin başında ortak bağlamı okur.

## Günlük kullanım

```bash
baglam ui        # tarayıcıda onay paneli
baglam pending   # ya da terminalde
baglam approve <id> · baglam reject <id> --note "neden"
```

Panel önerileri kart olarak gösterir: onayla, düzenle ve onayla ya da reddet. Klavye: `j`/`k` gezin, `a` onayla, `e` düzenle, `r` reddet. Ayrıca bütün kayıtları geçmişiyle, projelerini, güven kurallarını ve hangi araçların bağlı olduğunu gösterir. Panel sadece `127.0.0.1` üzerinde çalışır, açılış bağlantısı tek kullanımlıktır.

Kendin doğrudan ekle (hemen onaylı girer):

```bash
baglam add warning "Prod veritabanı salt okunur" "Ajanlar migration çalıştırmasın." --ttl 30
baglam add preference "Arayüz dili Türkçe" "Kullanıcıya görünen tüm metinler Türkçe." --to cursor,claude-code
baglam add decision "MySQL'e geçildi" "Ana veritabanı MySQL 8." --replaces <eski-id>
```

Türler: `decision` (karar), `convention` (kural), `preference` (tercih), `fact` (bilgi), `warning` (uyarı).

## Ajanların eline geçen

| MCP aracı | Ne yapar |
|---|---|
| `context_brief` | Projenin onaylı ve geçerli tüm kayıtları; önce uyarılar ve kararlar, belirli bir uzunluğu aşmadan |
| `context_search` | Onaylı kayıtlarda tam metin arama |
| `context_get` | Tek bir kayıt; neyin yerine geçtiği dahil |
| `context_propose` | Kayıt önerir; senin onayını bekler |
| `context_checkpoint` | Görevdeki ilerlemeyi kaydeder (hedef, bitenler, şu an, sıradaki, dosyalar); hemen paylaşılır |
| `context_handoff` | Devam eden görevin tüm ayrıntıları, son kayıtları ve git değişiklikleri |

Ajanlar `project_path` (çalıştıkları klasör) gönderir, böylece Bağlam projeyi her zaman bilir. Emin olamazsa tahmin etmek yerine yazmayı reddeder.

## Görevin ortasında ajan değiştirmek

Ajanlar her anlamlı adımdan sonra `context_checkpoint` ile ilerlemelerini kaydeder: hedef, bitenler, şu an yapılan, sıradaki adımlar ve önemli dosyalar. Araç değiştirdiğinde (Claude Code'un tokenı bitti, Codex'i açtın) yeni ajanın özeti şöyle başlar:

```
## Continue from here
Task: Stripe checkout (in progress) · last update 12 min ago by claude-code
Done: form validation; price calculation
Now: webhook handler in src/payment/webhook.ts
Next: 1) verify signature  2) idempotency  3) tests
Since then (git): 3 files changed, not committed: src/payment/webhook.ts, …
```

"Since then (git)" satırı ajandan değil git'ten gelir; önceki ajan habersiz kapansa bile doğrudur. Her proje ve dal için tek bir canlı görev tutulur, 7 gün sonra kendiliğinden silinir. İlerleme notları onaysız paylaşılır, gizli bilgi yine engellenir.

```bash
baglam handoff            # devam eden görev
baglam handoff --copy     # Bağlam'a bağlı olmayan bir araç için devam metnini kopyala
baglam handoff clear      # bitti olarak işaretle
```

Panel aynı bilgiyi Gelen kutusunun en üstünde bir kart olarak gösterir.

### Otomatik kayıt

Ajanlar bazen ilerlemeyi kaydetmeyi unutur. Bu yüzden `baglam setup` her araca küçük kancalar da kurar. Bu kancalar, ajan Bağlam'ı hiç çağırmasa bile devam eden görevi kendiliğinden kaydeder:

- **isteğin**, gönderdiğin anda (yeni bir görev başlatır ya da devam edene eklenir; böylece sonraki ajana "devam et" demen yeter);
- **ajanın değiştirdiği her dosya**;
- **ajanın son cevabı**, sırası bittiğinde ("Last reply: …"); ajan kendisi kaydettiyse bu adım atlanır.

Ajanın kendi kayıtları yine daha ayrıntılı kaynaktır; otomatik kayıt bir görevi asla "bitti" yapmaz, sıradaki adımları değiştirmez. Yalnızca `baglam init` çalıştırdığın klasörlerde çalışır, her şey bu bilgisayarda kalır, gizli bilgiler gizlenir.

```bash
baglam capture off        # bu projede kapat (varsayılan açık); panelde Ayarlar'da da var
```

Desteklenenler: Claude Code, Codex CLI, Cursor, Antigravity, Gemini CLI, VS Code (Copilot ajan kancaları, önizleme). Antigravity son cevabın metnini vermediği için orada yalnızca istek ve dosyalar kaydedilir. **Codex yeni kancalar için bir kez onay ister:** Codex'i aç, `/hooks` yaz ve Bağlam'ın kancalarını onayla. `baglam doctor` her araç için son otomatik kaydın ne zaman yapıldığını gösterir.

## Otonom mod (isteğe bağlı)

Onay için durmak istemiyor musun? Proje bazında:

```bash
baglam auto on
```

`baglam setup` ile kurulmuş ajanların kayıtları hemen paylaşılır, sen de sonradan gözden geçirirsin (`baglam review`, `baglam keep <id>`, `baglam undo <id>` ya da panel). Bir kaydın yerine geçeni geri alırsan eski kayıt geri gelir. Gizli bilgi yine engellenir, öneri sınırı geçerlidir, daha önce reddettiğin şeyler yine sana gelir. `baglam auto off` önce-onay düzenine döner.

## Güven kuralları (isteğe bağlı)

Varsayılan olarak her öneri seni bekler. Bazılarının onaysız geçmesini istersen:

```bash
baglam trust add --agent codex --kind fact          # bu proje
baglam trust add --kind convention --global         # bütün projeler
baglam trust list · baglam trust remove <id>
```

Güven kuralları şunlara hiçbir zaman uygulanmaz: gizli bilgiler (her zaman engellenir), başka bir kaydın yerine geçen kayıtlar, mevcut kayıtlara benzeyenler ve daha önce reddettiğin şeyler.

## Bir şey çalışmazsa

```bash
baglam doctor
```

Node'u, veritabanını, her aracın bağlantısını (sunucuyu aracın başlattığı gibi başlatarak) ve bulunduğun klasörü kontrol eder; her sorun için çözüm komutunu yazar. Ayrıntılar: [docs/troubleshooting.md](docs/troubleshooting.md), araç bazında kurulum: [docs/clients.md](docs/clients.md).

## Veriler

- Tek dosya: `~/.baglam/baglam.db` (yerini değiştirmek için `BAGLAM_DB`). Sürüm yükseltmelerinden önce otomatik yedek alınır.
- Proje ve ajan için `BAGLAM_PROJECT` ve `BAGLAM_AGENT`, inceleyen kişi için `BAGLAM_USER` kullanılır. `BAGLAM_FLOOD_LIMIT` inceleme kotasını, `BAGLAM_BRIEF_BUDGET` özet boyutunu belirler. `BAGLAM_AUTO_CAPTURE=0` otomatik kaydı, `BAGLAM_HOOK_INJECT=0` kancaların bağlam eklemesini kapatır. `BAGLAM_HANDOFF_TTL_DAYS` devir kayıtlarının saklama süresidir (varsayılan 7 gün).
- `baglam export --format md` okunabilir bir `CONTEXT.md` yazar. `--format json` geçmişiyle birlikte tam yedek alır. `baglam import <dosya>` yedeği geri birleştirir (mevcut kayıtların üzerine asla yazılmaz).
- Her değişiklik kaydedilir: kim önerdi, kim onayladı, düzenlemeler, kaldırmalar.

## Bilinmesi gerekenler

- Ajan adları `baglam setup`'ın verdiği etiketlerdir, güvenlik sınırı değildir: bilgisayarındaki herhangi bir program veritabanını zaten okuyabilir. Asıl sınır senin onayındır.
- `baglam setup` ile kurulmamış ajanlar adlarını kendileri bildirir; 20 önerilik sınır ada göre sayılır.
- Hız: 10.000'den fazla kayıtta bile özet, arama ve benzerlik kontrolü 50 ms'nin altında kalır.

## Geliştirme

```bash
npm install
npm test            # birim, MCP, CLI, panel API ve arayüz testleri, 10 bin kayıtlık hız testi
npm run typecheck
npm run build       # sunucu dist/ içine, panel dist/panel içine
npm run smoke       # paketle, geçici bir klasöre kur, kurulu CLI'yi çalıştır
```

Tasarım: [docs/superpowers/specs/2026-11-17-baglam-v1-design.md](docs/superpowers/specs/2026-11-17-baglam-v1-design.md). Lisans: MIT.
