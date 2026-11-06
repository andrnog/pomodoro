package main

// «Экранное время» iPhone.
//
// Если на iPhone включено «Учитывать на всех устройствах», macOS синхронизирует
// журнал «какое приложение на экране» в хранилище Biome:
//   ~/Library/Biome/streams/restricted/App.InFocus/remote/<device>/...
// Файлы в формате SEGB (v2), записи — protobuf. Мы читаем их (нужен
// «Полный доступ к диску»), считаем время по приложениям за каждый день
// и сохраняем в screentime.json, потому что macOS хранит историю ~месяц.

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // таблица поясов внутри бинаря
)

const macEpoch = 978307200 // 2001-01-01 в unix-секундах

// ---------- разбор SEGB ----------

type stEvent struct {
	t      float64 // секунды от 2001-01-01
	bundle string
	start  bool
	kind   uint64 // 1 — приложение, 3 — системный слой (шторка, папки)
}

func readVarint(b []byte, i int) (uint64, int, bool) {
	var r uint64
	var s uint
	for i < len(b) {
		c := b[i]
		i++
		r |= uint64(c&0x7f) << s
		if c < 0x80 {
			return r, i, true
		}
		s += 7
		if s > 63 {
			return 0, i, false
		}
	}
	return 0, i, false
}

func parseInFocus(rec []byte) (stEvent, bool) {
	var ev stEvent
	var haveT, haveB bool
	i := 0
	for i < len(rec) {
		key, ni, ok := readVarint(rec, i)
		if !ok {
			return ev, false
		}
		i = ni
		f, wt := key>>3, key&7
		switch wt {
		case 0:
			v, ni, ok := readVarint(rec, i)
			if !ok {
				return ev, false
			}
			i = ni
			switch f {
			case 2:
				ev.kind = v
			case 3:
				ev.start = v == 1
			}
		case 1:
			if i+8 > len(rec) {
				return ev, false
			}
			if f == 4 {
				ev.t = math.Float64frombits(binary.LittleEndian.Uint64(rec[i : i+8]))
				haveT = true
			}
			i += 8
		case 2:
			l, ni, ok := readVarint(rec, i)
			if !ok || ni+int(l) > len(rec) {
				return ev, false
			}
			i = ni
			if f == 6 {
				ev.bundle = string(rec[i : i+int(l)])
				haveB = true
			}
			i += int(l)
		case 5:
			i += 4
		default:
			return ev, false
		}
	}
	return ev, haveT && haveB && ev.t > 0
}

func parseSEGB(b []byte) []stEvent {
	if len(b) < 32 || string(b[:4]) != "SEGB" {
		return nil
	}
	n := int(binary.LittleEndian.Uint32(b[4:8]))
	var out []stEvent
	prev := 0
	for k := 0; k < n; k++ {
		off := len(b) - 16*(k+1)
		if off < 32 {
			break
		}
		end := int(binary.LittleEndian.Uint32(b[off : off+4]))
		state := binary.LittleEndian.Uint32(b[off+4 : off+8])
		start := (prev + 3) &^ 3
		prev = end
		a, z := 0x20+start, 0x20+end
		if state != 1 || z > len(b) || a+8 >= z {
			continue
		}
		if ev, ok := parseInFocus(b[a+8 : z]); ok {
			out = append(out, ev)
		}
	}
	return out
}

// ---------- подсчёт по дням ----------

type stApp struct {
	Sec   int `json:"s"`
	Opens int `json:"o"`
}

type stDay struct {
	Total   int              `json:"total"`
	Opens   int              `json:"opens"`
	First   string           `json:"first,omitempty"` // первое открытие за день, ЧЧ:ММ
	Last    string           `json:"last,omitempty"`
	Apps    map[string]stApp `json:"apps"`
	Hours   []map[string]int `json:"hours"` // 24 часа: приложение -> секунды
	Partial bool             `json:"partial,omitempty"`
}

func newDay() *stDay {
	d := &stDay{Apps: map[string]stApp{}, Hours: make([]map[string]int, 24)}
	for i := range d.Hours {
		d.Hours[i] = map[string]int{}
	}
	return d
}

// системные «приложения», которые не считаем
func ignoredBundle(b string) bool {
	if strings.HasPrefix(b, "com.apple.springboard") || b == "com.apple.SpringBoard" ||
		b == "com.apple.control-center" || b == "com.apple.PosterBoard" {
		return true
	}
	// системные окна поверх приложений: Face ID, оплата, скриншоты, наушники и т. п.
	if strings.HasPrefix(b, "com.apple.") && b != "com.apple.InCallService" &&
		(strings.HasSuffix(b, "Service") || strings.HasSuffix(b, "UI") || strings.Contains(b, "UIService")) {
		return true
	}
	return false
}

func toTime(t float64, loc *time.Location) time.Time {
	sec, frac := math.Modf(t)
	return time.Unix(int64(sec)+macEpoch, int64(frac*1e9)).In(loc)
}

func computeDays(evs []stEvent, now time.Time, loc *time.Location) (map[string]*stDay, time.Time) {
	sort.Slice(evs, func(i, j int) bool { return evs[i].t < evs[j].t })
	days := map[string]*stDay{}
	get := func(t time.Time) *stDay {
		k := t.Format("2006-01-02")
		if days[k] == nil {
			days[k] = newDay()
		}
		return days[k]
	}

	type sess struct {
		b    string
		s, e time.Time
	}
	var sessions []sess
	open := map[string]time.Time{}
	var lastEvent time.Time
	for _, ev := range evs {
		if ev.kind != 1 || ignoredBundle(ev.bundle) {
			continue
		}
		t := toTime(ev.t, loc)
		lastEvent = t
		if ev.start {
			open[ev.bundle] = t
			continue
		}
		s, ok := open[ev.bundle]
		if !ok {
			continue
		}
		delete(open, ev.bundle)
		if d := t.Sub(s); d > 0 && d < 4*time.Hour {
			sessions = append(sessions, sess{ev.bundle, s, t})
		}
	}
	// незакрытая сессия, которая идёт прямо сейчас
	for b, s := range open {
		if now.Sub(s) > 0 && now.Sub(s) < 30*time.Minute {
			sessions = append(sessions, sess{b, s, now})
		}
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].s.Before(sessions[j].s) })

	// короткие разрывы (шторка, баннер) не считаем новым открытием
	lastEnd := map[string]time.Time{}
	for _, se := range sessions {
		newOpen := true
		if le, ok := lastEnd[se.b]; ok && se.s.Sub(le) < 20*time.Second {
			newOpen = false
		}
		lastEnd[se.b] = se.e
		if newOpen {
			d := get(se.s)
			a := d.Apps[se.b]
			a.Opens++
			d.Apps[se.b] = a
			d.Opens++
			hm := se.s.Format("15:04")
			if d.First == "" || hm < d.First {
				d.First = hm
			}
		}
		// раскладываем по часам (в том числе через полночь)
		for cur := se.s; cur.Before(se.e); {
			next := time.Date(cur.Year(), cur.Month(), cur.Day(), cur.Hour(), 0, 0, 0, cur.Location()).Add(time.Hour)
			if next.After(se.e) {
				next = se.e
			}
			sec := int(next.Sub(cur).Seconds() + 0.5)
			if sec > 0 {
				d := get(cur)
				a := d.Apps[se.b]
				a.Sec += sec
				d.Apps[se.b] = a
				d.Total += sec
				d.Hours[cur.Hour()][se.b] += sec
				if hm := next.Add(-time.Second).Format("15:04"); hm > d.Last {
					d.Last = hm
				}
			}
			cur = next
		}
	}
	return days, lastEvent
}

// ---------- метаданные приложений ----------

type stMeta struct {
	Name    string `json:"name"`
	GenreID int    `json:"genreId,omitempty"`
	Genre   string `json:"genre,omitempty"`
	Icon    bool   `json:"icon,omitempty"`
	Checked int64  `json:"checked,omitempty"`
	Found   bool   `json:"found,omitempty"`
}

type stFile struct {
	Version   int                `json:"version"`
	Days      map[string]*stDay  `json:"days"`
	Apps      map[string]*stMeta `json:"apps"`
	Overrides map[string]string  `json:"overrides"`
	Names     map[string]string  `json:"names"`
	Lookup    bool               `json:"lookup"`
	LastSync  int64              `json:"lastSync"`
	LastEvent int64              `json:"lastEvent"`
	Device    string             `json:"device"`
	Timezone  string             `json:"timezone"`
}

var appleNames = map[string]string{
	"com.apple.mobilesafari": "Safari", "com.apple.MobileSMS": "Сообщения", "com.apple.mobilephone": "Телефон",
	"com.apple.InCallService": "Звонки", "com.apple.mobilenotes": "Заметки", "com.apple.camera": "Камера",
	"com.apple.mobileslideshow": "Фото", "com.apple.Preferences": "Настройки", "com.apple.mobiletimer": "Часы",
	"com.apple.ClockAngel": "Будильник", "com.apple.Maps": "Карты", "com.apple.Music": "Музыка",
	"com.apple.podcasts": "Подкасты", "com.apple.AppStore": "App Store", "com.apple.mobilemail": "Почта",
	"com.apple.mobilecal": "Календарь", "com.apple.reminders": "Напоминания", "com.apple.Health": "Здоровье",
	"com.apple.weather": "Погода", "com.apple.calculator": "Калькулятор", "com.apple.findmy": "Локатор",
	"com.apple.facetime": "FaceTime", "com.apple.shortcuts": "Команды", "com.apple.Passbook": "Wallet",
	"com.apple.tips": "Советы", "com.apple.DocumentsApp": "Файлы", "com.apple.VoiceMemos": "Диктофон",
	"com.apple.Bridge": "Watch", "com.apple.Fitness": "Фитнес", "com.apple.iBooks": "Книги",
	"com.apple.tv": "TV", "com.apple.news": "News", "com.apple.MobileAddressBook": "Контакты",
	"com.apple.Translate": "Переводчик", "com.apple.measure": "Рулетка", "com.apple.Magnifier": "Лупа",
	"com.apple.freeform": "Freeform", "com.apple.journal": "Дневник", "com.apple.Passwords": "Пароли",
	"com.apple.Home": "Дом", "com.apple.stocks": "Акции", "com.apple.compass": "Компас",
	"com.apple.musicrecognition": "Shazam", "com.apple.Health.Sleep": "Сон",
}

var appleCats = map[string]string{
	"com.apple.MobileSMS": "social", "com.apple.mobilephone": "social", "com.apple.InCallService": "social",
	"com.apple.facetime": "social", "com.apple.mobilemail": "productivity", "com.apple.mobilenotes": "productivity",
	"com.apple.mobilecal": "productivity", "com.apple.reminders": "productivity", "com.apple.mobilesafari": "info",
	"com.apple.Music": "entertainment", "com.apple.podcasts": "entertainment", "com.apple.tv": "entertainment",
	"com.apple.mobileslideshow": "entertainment", "com.apple.camera": "entertainment", "com.apple.iBooks": "info",
	"com.apple.news": "info", "com.apple.Health": "health", "com.apple.Fitness": "health",
	"com.apple.Passbook": "shopping", "com.apple.AppStore": "shopping", "com.apple.journal": "productivity",
}

// приложения, у которых жанр в App Store не совпадает с тем, как их воспринимают
var knownCats = map[string]string{
	"com.burbn.instagram": "social", "com.facebook.Facebook": "social", "com.atebits.Tweetie2": "social",
	"com.vk.vkclient": "social", "com.vk.vkmessenger": "social", "ph.telegra.Telegraph": "social",
	"net.whatsapp.WhatsApp": "social", "com.viber": "social", "com.toyopagroup.picaboo": "social",
	"com.zhiliaoapp.musically": "entertainment", "com.google.ios.youtube": "entertainment",
	"com.netflix.Netflix": "entertainment", "ru.yandex.mobile.music": "entertainment",
	"com.spotify.client": "entertainment", "tv.twitch": "entertainment", "com.reddit.Reddit": "social",
	"com.pinterest": "social", "com.hammerandchisel.discord": "social", "com.tinyspeck.chatlyio": "productivity",
	"com.google.chrome.ios": "info", "org.mozilla.ios.Firefox": "info", "ru.yandex.mobile": "info",
	"ru.yandex.mobile.search": "info", "com.openai.chat": "productivity", "com.anthropic.claude": "productivity",
}

// жанры App Store -> наши категории
func catByGenre(id int) string {
	switch {
	case id == 6005:
		return "social"
	case id == 6016 || id == 6008 || id == 6011:
		return "entertainment"
	case id == 6014 || (id >= 7001 && id <= 7019):
		return "games"
	case id == 6007 || id == 6000 || id == 6017 || id == 6026 || id == 6027 || id == 6006:
		return "productivity"
	case id == 6009 || id == 6018 || id == 6021:
		return "info"
	case id == 6024 || id == 6015 || id == 6023:
		return "shopping"
	case id == 6013 || id == 6020 || id == 6004:
		return "health"
	}
	return "other"
}

// shortName убирает хвосты вида «Gmail – почта от Google» и значки ™/®
func shortName(n string) string {
	n = strings.NewReplacer("™", "", "®", "").Replace(n)
	for _, sep := range []string{" – ", " — ", " - ", ": ", " | "} {
		if i := strings.Index(n, sep); i >= 2 {
			n = n[:i]
		}
	}
	return strings.TrimSpace(n)
}

var nonWord = regexp.MustCompile(`[^A-Za-z0-9]+`)

func prettyBundle(b string) string {
	parts := strings.Split(b, ".")
	last := parts[len(parts)-1]
	if len(parts) > 1 && (strings.EqualFold(last, "ios") || strings.EqualFold(last, "app") || strings.EqualFold(last, "client")) {
		last = parts[len(parts)-2]
	}
	last = strings.TrimSpace(nonWord.ReplaceAllString(last, " "))
	if last == "" {
		return b
	}
	return strings.ToUpper(last[:1]) + last[1:]
}

// ---------- синхронизация ----------

type screenTime struct {
	mu     sync.Mutex
	dir    string
	path   string
	data   stFile
	status string // ok | no_access | no_device | no_data
	err    string
}

func newScreenTime(dir string) *screenTime {
	s := &screenTime{dir: dir, path: filepath.Join(dir, "screentime.json"), status: "loading"}
	s.data = stFile{Version: 2, Days: map[string]*stDay{}, Apps: map[string]*stMeta{}, Overrides: map[string]string{}, Names: map[string]string{}, Lookup: true}
	if b, err := os.ReadFile(s.path); err == nil {
		var f stFile
		if json.Unmarshal(b, &f) == nil {
			if f.Days == nil {
				f.Days = map[string]*stDay{}
			}
			if f.Apps == nil {
				f.Apps = map[string]*stMeta{}
			}
			if f.Overrides == nil {
				f.Overrides = map[string]string{}
			}
			if f.Names == nil {
				f.Names = map[string]string{}
			}
			// v2: пересчитываем дни (исключены системные окна) и повторяем поиск ненайденных приложений
			if f.Version < 2 {
				f.Days = map[string]*stDay{}
				for b, m := range f.Apps {
					if !m.Found {
						delete(f.Apps, b)
					}
				}
				f.Version = 2
			}
			s.data = f
		}
	}
	os.MkdirAll(filepath.Join(dir, "icons"), 0o755)
	return s
}

// location — пояс, выбранный в приложении (или системный)
func (s *screenTime) location() *time.Location {
	if s.data.Timezone != "" {
		if l, err := time.LoadLocation(s.data.Timezone); err == nil {
			return l
		}
	}
	return time.Local
}

// save вызывается под s.mu
func (s *screenTime) save() {
	b, _ := json.Marshal(s.data)
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, s.path)
	}
}

func biomeRemote() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Biome", "streams", "restricted", "App.InFocus", "remote")
}

// sync перечитывает журнал iPhone и пересчитывает дни.
func (s *screenTime) sync() {
	root := biomeRemote()
	entries, err := os.ReadDir(root)
	if err != nil {
		s.mu.Lock()
		if errors.Is(err, fs.ErrPermission) {
			s.status = "no_access"
		} else {
			s.status = "no_device"
		}
		s.err = err.Error()
		s.mu.Unlock()
		return
	}
	// выбираем устройство с самыми свежими событиями
	var best []stEvent
	var bestDev string
	var bestLast float64
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		var evs []stEvent
		filepath.WalkDir(filepath.Join(root, e.Name()), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if b, err := os.ReadFile(p); err == nil {
				evs = append(evs, parseSEGB(b)...)
			}
			return nil
		})
		last := 0.0
		for _, ev := range evs {
			if ev.t > last {
				last = ev.t
			}
		}
		if len(evs) > 0 && last > bestLast {
			best, bestDev, bestLast = evs, e.Name(), last
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(best) == 0 {
		s.status = "no_data"
		if len(entries) == 0 {
			s.status = "no_device"
		}
		return
	}
	// убираем дубли (одни и те же записи бывают в нескольких файлах)
	seen := map[string]bool{}
	uniq := make([]stEvent, 0, len(best))
	for _, ev := range best {
		k := fmt.Sprintf("%.3f|%s|%v|%d", ev.t, ev.bundle, ev.start, ev.kind)
		if !seen[k] {
			seen[k] = true
			uniq = append(uniq, ev)
		}
	}
	loc := s.location()
	now := time.Now().In(loc)
	days, lastEvent := computeDays(uniq, now, loc)
	firstDay := ""
	for k := range days {
		if firstDay == "" || k < firstDay {
			firstDay = k
		}
	}
	for k, d := range days {
		// самый ранний день в журнале обычно неполный — не затираем сохранённую полную версию
		if k == firstDay {
			if old, ok := s.data.Days[k]; ok && old.Total >= d.Total {
				continue
			}
			d.Partial = true
		}
		s.data.Days[k] = d
	}
	s.data.Device = bestDev
	s.data.LastSync = now.Unix()
	if !lastEvent.IsZero() {
		s.data.LastEvent = lastEvent.Unix()
	}
	s.status = "ok"
	s.err = ""
	s.save()
}

// lookupApps подтягивает названия, жанры и иконки из App Store (iTunes Lookup API).
func (s *screenTime) lookupApps() {
	s.mu.Lock()
	if !s.data.Lookup {
		s.mu.Unlock()
		return
	}
	var need []string
	seen := map[string]bool{}
	for _, d := range s.data.Days {
		for b := range d.Apps {
			if seen[b] || strings.HasPrefix(b, "com.apple.") {
				continue
			}
			seen[b] = true
			m := s.data.Apps[b]
			if m == nil || (!m.Found && time.Since(time.Unix(m.Checked, 0)) > 7*24*time.Hour) {
				need = append(need, b)
			}
		}
	}
	s.mu.Unlock()
	sort.Strings(need)
	client := http.Client{Timeout: 15 * time.Second}
	for i := 0; i < len(need); i += 40 {
		batch := need[i:min(i+40, len(need))]
		rest := s.lookupBatch(&client, batch, "country=ru&lang=ru_ru")
		if len(rest) > 0 {
			rest = s.lookupBatch(&client, rest, "country=us")
		}
		s.mu.Lock()
		for _, b := range rest {
			s.data.Apps[b] = &stMeta{Name: prettyBundle(b), Checked: time.Now().Unix()}
		}
		s.save()
		s.mu.Unlock()
	}
}

// lookupBatch ищет приложения в App Store указанной страны и возвращает ненайденные.
func (s *screenTime) lookupBatch(client *http.Client, batch []string, region string) []string {
	{
		u := "https://itunes.apple.com/lookup?" + region + "&entity=software&bundleId=" + url.QueryEscape(strings.Join(batch, ","))
		resp, err := client.Get(u)
		if err != nil {
			log.Println("экранное время: поиск приложений:", err)
			return nil
		}
		var res struct {
			Results []struct {
				BundleID      string `json:"bundleId"`
				TrackName     string `json:"trackName"`
				PrimaryGenre  string `json:"primaryGenreName"`
				PrimaryGenreI int    `json:"primaryGenreId"`
				Artwork       string `json:"artworkUrl100"`
			} `json:"results"`
		}
		json.NewDecoder(resp.Body).Decode(&res)
		resp.Body.Close()
		found := map[string]bool{}
		for _, r := range res.Results {
			found[r.BundleID] = true
			m := &stMeta{Name: r.TrackName, GenreID: r.PrimaryGenreI, Genre: r.PrimaryGenre, Found: true, Checked: time.Now().Unix()}
			if r.Artwork != "" && s.downloadIcon(client, r.BundleID, r.Artwork) {
				m.Icon = true
			}
			s.mu.Lock()
			s.data.Apps[r.BundleID] = m
			s.mu.Unlock()
		}
		var rest []string
		for _, b := range batch {
			if !found[b] {
				rest = append(rest, b)
			}
		}
		return rest
	}
}

var safeName = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func (s *screenTime) iconPath(bundle string) string {
	return filepath.Join(s.dir, "icons", safeName.ReplaceAllString(bundle, "_")+".png")
}

func (s *screenTime) downloadIcon(c *http.Client, bundle, art string) bool {
	art = strings.Replace(art, "100x100bb", "128x128bb", 1)
	resp, err := c.Get(art)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil || len(b) < 100 {
		return false
	}
	return os.WriteFile(s.iconPath(bundle), b, 0o644) == nil
}

// ---------- HTTP ----------

type stAppOut struct {
	Name  string `json:"name"`
	Cat   string `json:"cat"`
	Icon  bool   `json:"icon"`
	Genre string `json:"genre,omitempty"`
}

func (s *screenTime) appInfo(b string) stAppOut {
	out := stAppOut{Name: prettyBundle(b), Cat: "other"}
	if n, ok := appleNames[b]; ok {
		out.Name = n
	}
	if m := s.data.Apps[b]; m != nil {
		if m.Name != "" && !(m.Name == prettyBundle(b) && appleNames[b] != "") {
			out.Name = shortName(m.Name)
		}
		out.Icon = m.Icon
		out.Genre = m.Genre
		out.Cat = catByGenre(m.GenreID)
	}
	if c, ok := appleCats[b]; ok {
		out.Cat = c
	}
	if c, ok := knownCats[b]; ok {
		out.Cat = c
	}
	if c, ok := s.data.Overrides[b]; ok {
		out.Cat = c
	}
	if n, ok := s.data.Names[b]; ok && n != "" {
		out.Name = n
	}
	return out
}

func (s *screenTime) payload() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	apps := map[string]stAppOut{}
	for _, d := range s.data.Days {
		for b := range d.Apps {
			if _, ok := apps[b]; !ok {
				apps[b] = s.appInfo(b)
			}
		}
	}
	return map[string]any{
		"status":    s.status,
		"error":     s.err,
		"days":      s.data.Days,
		"apps":      apps,
		"lookup":    s.data.Lookup,
		"lastSync":  s.data.LastSync,
		"lastEvent": s.data.LastEvent,
		"timezone":  s.data.Timezone,
	}
}

func (s *screenTime) register(mux *http.ServeMux) {
	writeJSON := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/api/screentime", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, s.payload())
	})
	mux.HandleFunc("/api/screentime/sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		s.sync()
		go s.lookupApps()
		writeJSON(w, s.payload())
	})
	mux.HandleFunc("/api/screentime/category", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		var req struct {
			Bundle string
			Cat    *string
			Name   *string
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || req.Bundle == "" {
			http.Error(w, "bad request", 400)
			return
		}
		s.mu.Lock()
		if req.Cat != nil {
			if *req.Cat == "" {
				delete(s.data.Overrides, req.Bundle)
			} else {
				s.data.Overrides[req.Bundle] = *req.Cat
			}
		}
		if req.Name != nil {
			n := strings.TrimSpace(*req.Name)
			if n == "" {
				delete(s.data.Names, req.Bundle)
			} else {
				s.data.Names[req.Bundle] = n
			}
		}
		s.save()
		s.mu.Unlock()
		writeJSON(w, s.payload())
	})
	mux.HandleFunc("/api/screentime/settings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		var req struct {
			Lookup   *bool
			Timezone *string
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		resync := false
		s.mu.Lock()
		if req.Lookup != nil {
			s.data.Lookup = *req.Lookup
		}
		if req.Timezone != nil && *req.Timezone != s.data.Timezone {
			if _, err := time.LoadLocation(*req.Timezone); err == nil || *req.Timezone == "" {
				s.data.Timezone = *req.Timezone
				resync = true
			}
		}
		s.save()
		lookup := req.Lookup != nil && *req.Lookup
		s.mu.Unlock()
		if resync {
			s.sync()
		}
		if lookup {
			go s.lookupApps()
		}
		writeJSON(w, s.payload())
	})
	mux.HandleFunc("/api/screentime/icon", func(w http.ResponseWriter, r *http.Request) {
		b, err := os.ReadFile(s.iconPath(r.URL.Query().Get("b")))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(b)
	})
}

// фоновая синхронизация раз в 10 минут
func (s *screenTime) loop() {
	for {
		s.sync()
		s.lookupApps()
		time.Sleep(10 * time.Minute)
	}
}
