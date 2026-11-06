// Pomodoro — локальный помодоро-таймер.
// Запускает HTTP-сервер на 127.0.0.1, отдаёт веб-интерфейс и хранит данные
// в ~/Library/Application Support/Pomodoro/ (рабочая копия, порт 47321)
// или ~/Library/Application Support/Pomodoro Dev/ (разработка, порт 47322).
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

// channel задаётся при сборке: prod — рабочая копия с реальными данными,
// dev — копия для разработки (свой порт и своя папка с данными).
var (
	channel = "dev"
	version = "dev"
)

const maxBody = 20 << 20 // 20 MB

var (
	addr   = "127.0.0.1:47321"
	appURL = "http://" + addr + "/"
)

func init() {
	if channel != "prod" {
		addr = "127.0.0.1:47322"
	}
	// адрес можно переопределить, например если порт занят: POMODORO_ADDR=127.0.0.1:48000
	if v := os.Getenv("POMODORO_ADDR"); v != "" {
		addr = v
	}
	appURL = "http://" + addr + "/"
}

type store struct {
	mu   sync.Mutex
	path string
}

func (s *store) read() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return []byte("{}"), nil
	}
	return b, err
}

func (s *store) write(b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// резервная копия предыдущей версии
	if old, err := os.ReadFile(s.path); err == nil && len(old) > 2 {
		_ = os.WriteFile(s.path+".bak", old, 0o644)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func dataDir() string {
	if d := os.Getenv("POMODORO_DATA_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	name := "Pomodoro"
	if channel != "prod" {
		name = "Pomodoro Dev"
	}
	return filepath.Join(home, "Library", "Application Support", name)
}

// backupLoop раз в день складывает копии данных в backups/ГГГГ-ММ-ДД и хранит последние 60 дней.
func backupLoop(dir string) {
	for {
		day := time.Now().Format("2006-01-02")
		dst := filepath.Join(dir, "backups", day)
		if err := os.MkdirAll(dst, 0o755); err == nil {
			for _, f := range []string{"data.json", "screentime.json"} {
				if b, err := os.ReadFile(filepath.Join(dir, f)); err == nil && len(b) > 2 {
					_ = os.WriteFile(filepath.Join(dst, f), b, 0o644)
				}
			}
		}
		if entries, err := os.ReadDir(filepath.Join(dir, "backups")); err == nil {
			cutoff := time.Now().AddDate(0, 0, -60).Format("2006-01-02")
			for _, e := range entries {
				if e.IsDir() && e.Name() < cutoff {
					os.RemoveAll(filepath.Join(dir, "backups", e.Name()))
				}
			}
		}
		time.Sleep(3 * time.Hour)
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// alreadyRunning проверяет, не запущен ли уже наш сервер.
func alreadyRunning() bool {
	c := http.Client{Timeout: 700 * time.Millisecond}
	resp, err := c.Get(appURL + "api/ping")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b) == "pomodoro"
}

func main() {
	noBrowser := len(os.Args) > 1 && os.Args[1] == "--no-browser"

	dir := dataDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatal(err)
	}
	logFile, err := os.OpenFile(filepath.Join(dir, "server.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if alreadyRunning() {
			log.Println("сервер уже запущен — открываю браузер")
			if !noBrowser {
				openBrowser(appURL)
			}
			return
		}
		log.Fatalf("не удалось занять %s: %v", addr, err)
	}

	st := &store{path: filepath.Join(dir, "data.json")}
	sub, _ := fs.Sub(webFS, "web")

	mux := http.NewServeMux()
	mux.Handle("/", noCache(http.FileServer(http.FS(sub))))
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "pomodoro")
	})
	mux.HandleFunc("/api/data", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			b, err := st.read()
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(b)
		case http.MethodPut:
			b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			if !json.Valid(b) {
				http.Error(w, "invalid json", 400)
				return
			}
			if err := st.write(b); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", 405)
		}
	})
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"dataFile": st.path, "channel": channel, "version": version, "backups": filepath.Join(dir, "backups")})
	})
	go backupLoop(dir)
	stime := newScreenTime(dir)
	stime.register(mux)
	go stime.loop()
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		go func() {
			time.Sleep(200 * time.Millisecond)
			log.Println("остановка по запросу из интерфейса")
			os.Exit(0)
		}()
	})

	log.Printf("Pomodoro запущен: %s (данные: %s)", appURL, st.path)
	if !noBrowser {
		go func() {
			time.Sleep(150 * time.Millisecond)
			openBrowser(appURL)
		}()
	}
	log.Fatal(http.Serve(ln, mux))
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}
