#!/usr/bin/env python3
"""
Pinterest Board Downloader (GUI) — Streaming + Minimal Enter-to-Login
- NEW login logic (per request):
    1) Open https://www.pinterest.com/
    2) Fill the email and password fields
    3) Press Enter to submit (no button lookups)
- Ensures board is ready (pins present) before enabling Start.
- Modes:
    • Thumbnails (fast; stays on board) — STREAMS while scrolling, no duplicates
    • Pin pages (bigger; dedicated worker tab) — STREAMS while scrolling, no duplicates

Install:
    pip install selenium requests webdriver-manager
"""

import os
import re
import time
import threading
import urllib.parse
from pathlib import Path
from typing import Optional, Dict, Set, List

import requests

import tkinter as tk
from tkinter import ttk, filedialog, messagebox

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.common.keys import Keys  # for pressing Enter

# ======== YOUR CREDENTIALS (edit these two!) ========
PINTEREST_EMAIL    = "cheerandjoy@yahoo.com"
PINTEREST_PASSWORD = "Taijutsu10^!!"
# =====================================================

# Driver helper
try:
    from webdriver_manager.chrome import ChromeDriverManager
    _USE_WDM = True
except Exception:
    _USE_WDM = False

# ---------------- Config --------------
SCROLL_PAUSE_MIN   = 0.6
SCROLL_PAUSE_MAX   = 4
MAX_IDLE_SCROLLS   = 2
REQUEST_TIMEOUT    = 5
PIN_WAIT_SECONDS   = 25
LOGIN_WAIT_SECONDS = 25
# -------------------------------------


def jitter(a: float, b: float) -> float:
    import random
    return random.uniform(a, b)


def extract_pin_id_from_href(href: str) -> Optional[str]:
    m = re.search(r"/pin/(\d+)/?", href)
    return m.group(1) if m else None


def pick_largest_from_srcset(srcset: str) -> Optional[str]:
    best_url, best_w = None, -1
    for part in (srcset or "").split(","):
        part = part.strip()
        if not part:
            continue
        pieces = part.split()
        url = pieces[0]
        w = -1
        if len(pieces) > 1 and pieces[1].endswith("w"):
            try:
                w = int(pieces[1][:-1])
            except ValueError:
                w = -1
        if w > best_w:
            best_url, best_w = url, w
    return best_url


def safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\-.]+", "_", name)
    return name[:180]


def filename_from_url(url: str, pin_id: Optional[str]) -> str:
    base = os.path.basename(urllib.parse.urlparse(url).path)
    if not base:
        base = f"{pin_id or 'image'}.jpg"
    if not re.search(r"\.(jpe?g|png|webp)$", base, re.I):
        base = f"{Path(base).stem or (pin_id or 'image')}.jpg"
    return safe_filename(base)


def download_image(url: str, out_dir: Path, pin_id: Optional[str]) -> bool:
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / filename_from_url(url, pin_id)
    if dest.exists():
        return True
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.pinterest.com/"}
    try:
        with requests.get(url, headers=headers, stream=True, timeout=REQUEST_TIMEOUT) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_content(chunk_size=262_144):
                    if chunk:
                        f.write(chunk)
        return True
    except Exception:
        return False


def launch_chrome(use_profile: bool, profile_dir: Path) -> webdriver.Chrome:
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument("--start-maximized")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    if use_profile:
        chrome_options.add_argument(f"--user-data-dir={profile_dir}")
    if _USE_WDM:
        return webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
    return webdriver.Chrome(options=chrome_options)


def _is_valid_board_url(url: str) -> bool:
    return bool(re.match(r"^https?://([a-z]+\.)?pinterest\.[a-z]+/.+/.+/?$", url.strip(), re.I))


def _element_or_none(driver, by, selector):
    try:
        return driver.find_element(by, selector)
    except NoSuchElementException:
        return None


def perform_auto_login(driver: webdriver.Chrome, email: str, password: str, log_fn, target_board_url: str) -> bool:
    """
    Minimal login path:
      - Open https://www.pinterest.com/
      - Fill email + password
      - Press Enter to submit
      - WAIT 5 seconds (no additional login checks)
      - Navigate to the target board URL
    """
    try:
        log_fn("Navigating to pinterest.com …")
        driver.get("https://www.pinterest.com/")
        wait = WebDriverWait(driver, LOGIN_WAIT_SECONDS)

        # Inputs: email + password (no 'Log in' button lookups)
        email_input = wait.until(EC.visibility_of_element_located((
            By.XPATH,
            "//input[@name='id' or @type='email' or @autocomplete='username']"
        )))
        password_input = wait.until(EC.visibility_of_element_located((
            By.XPATH,
            "//input[@name='password' or @type='password' or @autocomplete='current-password']"
        )))

        email_input.clear()
        email_input.send_keys(email)
        time.sleep(0.2)
        password_input.clear()
        password_input.send_keys(password)
        password_input.send_keys(Keys.ENTER)
        log_fn("Submitted credentials via Enter key. Waiting 5 seconds…")

        # ⏳ Replace previous wait logic with a simple fixed delay
        time.sleep(5)

        log_fn("Navigating to your board URL…")
        driver.get(target_board_url)
        return True

    except TimeoutException:
        log_fn("Login flow timed out; you can complete it manually in the window.")
        return False
    except Exception as e:
        log_fn(f"Login error: {e}")
        return False


def ensure_board_ready(driver: webdriver.Chrome, log_fn, timeout: int = 20) -> bool:
    """
    Make sure the board page actually shows pins.
    Nudge the page (small scroll), dismiss obvious banners, and refresh once if needed.
    """
    def has_pins(d):
        return len(d.find_elements(By.CSS_SELECTOR, "a[href*='/pin/'] img")) > 0

    end = time.time() + timeout
    while time.time() < end:
        if has_pins(driver):
            return True
        # dismiss overlays
        for sel in [
            "button[aria-label*='Accept']",
            "button[aria-label*='Close']",
            "[data-test-id='close-button']",
        ]:
            btns = driver.find_elements(By.CSS_SELECTOR, sel)
            if btns:
                try:
                    btns[0].click()
                except Exception:
                    pass
        # gentle scroll to trigger lazy load
        driver.execute_script("window.scrollBy(0, 400);")
        time.sleep(0.4)
        driver.execute_script("window.scrollBy(0, -400);")
        time.sleep(0.6)
        if has_pins(driver):
            return True
        time.sleep(0.3)

    log_fn("Pins not visible yet—reloading once…")
    driver.refresh()
    try:
        WebDriverWait(driver, 12).until(lambda d: has_pins(d))
        return True
    except Exception:
        return has_pins(driver)


def get_image_url_from_pin_page(driver: webdriver.Chrome, wait: WebDriverWait) -> Optional[str]:
    # 1) og:image
    try:
        meta = wait.until(lambda d: d.find_element(By.CSS_SELECTOR, "meta[property='og:image']"))
        og = meta.get_attribute("content")
        if og and og.startswith("http"):
            return og
    except Exception:
        pass
    # 2) any <img srcset>
    try:
        imgs = driver.find_elements(By.CSS_SELECTOR, "img[srcset]")
        for img in imgs:
            ss = img.get_attribute("srcset") or ""
            url = pick_largest_from_srcset(ss)
            if url and url.startswith("http"):
                return url
    except Exception:
        pass
    # 3) any <img src>
    try:
        imgs = driver.find_elements(By.CSS_SELECTOR, "img[src]")
        for img in imgs:
            url = img.get_attribute("src") or ""
            if url.startswith("http"):
                return url
    except Exception:
        pass
    return None


# ---------------- Tkinter GUI app ----------------
class PinterestDownloaderApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Pinterest Board Downloader")
        self.geometry("880x660")
        self.minsize(840, 620)

        self.var_url = tk.StringVar()
        self.var_folder = tk.StringVar(value=str(Path.cwd() / "pinterest_downloads"))
        self.var_use_profile = tk.BooleanVar(value=False)      # isolated by default
        self.var_mode = tk.StringVar(value="thumbnails")       # thumbnails or pin_pages
        self.var_auto_login = tk.BooleanVar(value=True)        # auto-login toggle

        self.profile_dir = Path.home() / ".chrome-pinterest-profile"

        self.btn_open = None
        self.btn_start = None
        self.btn_cancel = None
        self.btn_close = None
        self.progress = None
        self.log = None

        self.worker: Optional[threading.Thread] = None
        self.cancel_flag = threading.Event()

        self.driver: Optional[webdriver.Chrome] = None
        self.board_handle: Optional[str] = None
        self.worker_handle: Optional[str] = None

        self._build_ui()

    def _build_ui(self):
        pad = {"padx": 10, "pady": 6}

        # Row 1: URL (with history combobox)
        row1 = ttk.Frame(self)
        row1.pack(fill="x", **pad)
        ttk.Label(row1, text="Board URL:").pack(side="left")

        self.url_history_file = Path.home() / ".pinterest_board_urls.txt"
        self.url_history = self._load_url_history()
        self.combo_url = ttk.Combobox(row1, textvariable=self.var_url, values=self.url_history, width=70)
        self.combo_url.pack(side="left", fill="x", expand=True, padx=8)
        if self.url_history:
            self.combo_url.set(self.url_history[0])
        else:
            self.combo_url.set("https://www.pinterest.com/<you>/<board-slug>/")
        self.combo_url.bind("<<ComboboxSelected>>", lambda _: self.var_url.set(self.combo_url.get()))

        # Row 2: Folder
        row2 = ttk.Frame(self)
        row2.pack(fill="x", **pad)
        ttk.Label(row2, text="Download folder:").pack(side="left")
        ttk.Entry(row2, textvariable=self.var_folder).pack(side="left", fill="x", expand=True, padx=8)
        ttk.Button(row2, text="Browse…", command=self._choose_folder).pack(side="left")

        # Row 3: Options
        row3 = ttk.Frame(self)
        row3.pack(fill="x", **pad)
        ttk.Checkbutton(row3, text="Reuse Chrome profile (stay logged in)", variable=self.var_use_profile)\
            .pack(side="left", padx=(0, 12))
        ttk.Label(row3, text="Mode:").pack(side="left")
        ttk.Radiobutton(row3, text="Thumbnails (fast)", value="thumbnails", variable=self.var_mode)\
            .pack(side="left")
        ttk.Radiobutton(row3, text="Pin pages (larger)", value="pin_pages", variable=self.var_mode)\
            .pack(side="left", padx=(6, 16))
        ttk.Checkbutton(row3, text="Auto-login on open", variable=self.var_auto_login).pack(side="left")

        # Row 4: Controls
        row4 = ttk.Frame(self)
        row4.pack(fill="x", **pad)
        self.btn_open = ttk.Button(row4, text="Open Browser", command=self._open_browser)
        self.btn_open.pack(side="left")
        self.btn_start = ttk.Button(row4, text="Start", command=self._start, state="disabled")
        self.btn_start.pack(side="left", padx=6)
        self.btn_cancel = ttk.Button(row4, text="Cancel", command=self._cancel, state="disabled")
        self.btn_cancel.pack(side="left", padx=6)
        self.btn_close = ttk.Button(row4, text="Close Browser", command=self._close_browser, state="disabled")
        self.btn_close.pack(side="left", padx=6)
        ttk.Button(row4, text="Help", command=self._help).pack(side="right")

        # Row 5: Progress
        row5 = ttk.Frame(self)
        row5.pack(fill="x", **pad)
        self.progress = ttk.Progressbar(row5, mode="determinate", maximum=100)
        self.progress.pack(fill="x")

        # Row 6: Log
        row6 = ttk.Frame(self)
        row6.pack(fill="both", expand=True, **pad)
        ttk.Label(row6, text="Log:").pack(anchor="w")
        self.log = tk.Text(row6, height=16, wrap="word")
        self.log.pack(fill="both", expand=True)
        self.log.configure(state="disabled")

        ttk.Label(
            self,
            foreground="#555",
            text="Step 1: Open Browser (auto-login if enabled) • Step 2: Start."
        ).pack(anchor="w", padx=10, pady=(0, 10))

    def _load_url_history(self) -> List[str]:
        if self.url_history_file.exists():
            try:
                with open(self.url_history_file, "r", encoding="utf-8") as f:
                    urls = [line.strip() for line in f if line.strip()]
                return urls
            except Exception:
                return []
        return []

    # ---- UI helpers ----
    def _choose_folder(self):
        chosen = filedialog.askdirectory(initialdir=self.var_folder.get() or str(Path.cwd()))
        if chosen:
            self.var_folder.set(chosen)

    def _help(self):
        messagebox.showinfo(
            "Notes",
            "• Auto-login uses the email/password constants in the script.\n"
            "• It types on pinterest.com and hits Enter.\n"
            "• If a captcha appears, solve it manually, then click Start.\n"
            "• Start is enabled only when the board grid is detected."
        )

    def _log(self, msg: str):
        self.log.configure(state="normal")
        self.log.insert("end", msg.rstrip() + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")
        self.update_idletasks()

    def _set_progress(self, value: float, maximum: Optional[float] = None):
        if maximum and maximum > 0:
            self.progress.configure(maximum=maximum)
        self.progress["value"] = value
        self.update_idletasks()

    def _navigate_to_board(self) -> bool:
        """
        Navigates to the board URL currently selected in the GUI.
        Returns True if navigation appears successful, False otherwise.
        """
        board_url = (self.var_url.get() or "").strip()
        try:
            self._log(f"Navigating to board: {board_url}")
            self.driver.get(board_url)
            WebDriverWait(self.driver, 12).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, "a[href*='/pin/']") or "board" in d.current_url
            )
            return True
        except Exception as e:
            self._log(f"Failed to navigate to board: {e}")
            return False

    # ---- two-step controls ----
    def _open_browser(self):
        url = self.var_url.get().strip()
        if not _is_valid_board_url(url):
            messagebox.showerror("Missing URL", "Please paste a valid Pinterest board URL.")
            return
        try:
            if not self.driver:
                self._log("Launching Chrome…")
                self.driver = launch_chrome(self.var_use_profile.get(), self.profile_dir)

            navigated_ok = False

            # Auto-login flow
            if self.var_auto_login.get():
                self._log("Attempting login on pinterest.com via Enter …")
                ok = perform_auto_login(self.driver, PINTEREST_EMAIL, PINTEREST_PASSWORD, self._log, url)
                if not ok:
                    self._log("Login failed or timed out; you can log in manually in the browser.")
                    # If login failed, try navigating to the board anyway
                    navigated_ok = self._navigate_to_board()
                else:
                    # perform_auto_login already sent us to the board URL
                    navigated_ok = True
            else:
                self._log("Opening your board URL directly (manual login may be required)…")
                navigated_ok = self._navigate_to_board()

            if navigated_ok and ensure_board_ready(self.driver, self._log, timeout=20):
                self._log("Board looks ready.")
                self.btn_start.configure(state="normal")
            else:
                self._log("Board not fully ready; you can still click Start and it will try to scroll/load.")

            self.board_handle = self.driver.current_window_handle
            self.btn_close.configure(state="normal")
            self._set_progress(0, 100)

            # Save URL to history (front of list) if new
            if url and (not self.url_history or url != self.url_history[0]):
                try:
                    existing = [u for u in self.url_history if u != url]
                    self.url_history = [url] + existing
                    with open(self.url_history_file, "w", encoding="utf-8") as f:
                        f.write("\n".join(self.url_history[:30]))
                    self.combo_url["values"] = self.url_history
                except Exception:
                    pass

        except Exception as e:
            self._log(f"Failed to open/login: {e}")
            messagebox.showerror("Error", f"Failed to open/login:\n{e}")

    def _start(self):
        if not self.driver or not self.board_handle:
            messagebox.showerror("No browser", "Open the browser first, then click Start.")
            return

        out_dir = Path(self.var_folder.get().strip() or (Path.cwd() / "pinterest_downloads"))
        out_dir.mkdir(parents=True, exist_ok=True)

        self.btn_start.configure(state="disabled")
        self.btn_open.configure(state="disabled")
        self.btn_cancel.configure(state="normal")
        self.cancel_flag.clear()
        self._set_progress(0, 100)

        mode = self.var_mode.get()
        self._log(f"Starting download in mode: {mode}")
        target = self._run_worker_thumbnails if mode == "thumbnails" else self._run_worker_pinpages
        self.worker = threading.Thread(target=target, args=(out_dir,), daemon=True)
        self.worker.start()
        self.after(300, self._poll_worker)

    def _cancel(self):
        if self.worker and self.worker.is_alive():
            self.cancel_flag.set()
            self._log("Cancel requested…")

    def _close_browser(self):
        try:
            if self.driver:
                self._log("Closing browser…")
                self.driver.quit()
        except Exception:
            pass
        finally:
            self.driver = None
            self.board_handle = None
            self.worker_handle = None
            self.btn_close.configure(state="disabled")
            self.btn_start.configure(state="disabled")
            self.btn_open.configure(state="normal")

    def _poll_worker(self):
        if self.worker and self.worker.is_alive():
            self.after(300, self._poll_worker)
        else:
            self.btn_cancel.configure(state="disabled")
            self.btn_open.configure(state="normal")
            self.btn_close.configure(state="normal")

    # ======== STREAMING HELPERS ========
    def _collect_new_grid_thumbs(self, driver: webdriver.Chrome, seen_pin_ids: Set[str]) -> Dict[str, str]:
        """
        Scan the currently loaded grid for thumbnails and return only new {pin_id: url}.
        """
        new_map: Dict[str, str] = {}
        img_elems = driver.find_elements(By.CSS_SELECTOR, 'a[href*="/pin/"] img')
        for img in img_elems:
            try:
                href = driver.execute_script(
                    "var a = arguments[0].closest('a[href*=\"/pin/\"]'); return a ? a.href : null;",
                    img,
                )
                if not href:
                    continue
                pin_id = extract_pin_id_from_href(href or "")
                if not pin_id or pin_id in seen_pin_ids or pin_id in new_map:
                    continue
                srcset = img.get_attribute("srcset") or ""
                url = pick_largest_from_srcset(srcset)
                if not url:
                    url = (
                        img.get_attribute("src")
                        or img.get_attribute("data-src")
                        or img.get_attribute("data-pin-media")
                        or ""
                    )
                if isinstance(url, str) and url.startswith("http"):
                    new_map[pin_id] = url
            except Exception:
                continue
        return new_map

    def _collect_new_pin_links(self, driver: webdriver.Chrome, seen_links: Set[str]) -> List[str]:
        """
        Scan the currently loaded grid for pin links and return only new hrefs.
        """
        new_links: List[str] = []
        anchors = driver.find_elements(By.CSS_SELECTOR, "a[href*='/pin/']")
        for a in anchors:
            try:
                href = a.get_attribute("href") or ""
                if "/pin/" in href and href not in seen_links:
                    seen_links.add(href)
                    new_links.append(href)
            except Exception:
                continue
        return new_links

    # ======== WORKERS (STREAMING) ========
    def _run_worker_thumbnails(self, out_dir: Path):
        d = self.driver
        if not d:
            self._log("No browser available.")
            return

        successes = 0
        errors = 0
        seen_pin_ids: Set[str] = set()

        try:
            self._log("Streaming thumbnails with slow, incremental scrolling from the top…")
            try:
                WebDriverWait(d, 12).until(EC.presence_of_element_located((By.CSS_SELECTOR, "a[href*='/pin/']")))
            except Exception:
                self._log("Pins not visible yet—starting scroll loop anyway.")

            # Jump to the top to begin a full sweep
            d.execute_script("window.scrollTo(0, 0);")
            time.sleep(0.5)

            # Progress bar is approximate; we’ll update based on scroll position
            self._set_progress(0, 100)

            # Step size: ~70% of viewport height (gentle overlap to avoid gaps)
            viewport_h = d.execute_script("return window.innerHeight || 800;") or 800
            step_px = int(viewport_h * 0.7)

            def doc_height():
                return d.execute_script("""
                    return Math.max(
                      document.body.scrollHeight, document.documentElement.scrollHeight,
                      document.body.offsetHeight,  document.documentElement.offsetHeight,
                      document.body.clientHeight,  document.documentElement.clientHeight
                    );
                """)

            last_height = doc_height()
            y = 0
            stable_at_bottom = 0  # how many times we've seen no growth at bottom

            while not self.cancel_flag.is_set():
                # 1) Collect new thumbnails currently in view
                new_map = self._collect_new_grid_thumbs(d, seen_pin_ids)
                if new_map:
                    for pin_id, url in new_map.items():
                        if self.cancel_flag.is_set():
                            break
                        ok = download_image(url, out_dir, pin_id)
                        if ok:
                            seen_pin_ids.add(pin_id)
                            successes += 1
                            self._log(f"Saved thumbnail ✓  (total={successes})")
                        else:
                            errors += 1
                            self._log(f"Download failed ✗ (pin {pin_id})")

                # 2) Compute next scroll position and move gently
                next_y = y + step_px
                page_h = doc_height()
                at_bottom_now = (y + viewport_h) >= (page_h - 10)

                if at_bottom_now:
                    # Give Pinterest time to append more content at bottom
                    time.sleep(jitter(SCROLL_PAUSE_MIN, SCROLL_PAUSE_MAX))
                    new_h = doc_height()
                    if new_h > page_h:
                        # More content loaded—keep going from (almost) the bottom
                        last_height = new_h
                        # Nudge slightly up then down again to trigger more lazy loads
                        d.execute_script("window.scrollBy(0, -200);")
                        time.sleep(0.25)
                        d.execute_script("window.scrollTo(0, arguments[0]);", new_h - viewport_h)
                        y = new_h - viewport_h
                        stable_at_bottom = 0
                        continue
                    else:
                        # Nothing new appended—count stability and maybe finish
                        stable_at_bottom += 1
                        if stable_at_bottom >= MAX_IDLE_SCROLLS:
                            break
                else:
                    # Not at bottom; continue our gentle descent
                    d.execute_script("window.scrollTo(0, arguments[0]);", next_y)
                    y = next_y
                    # Update progress bar roughly by how far we are through the document
                    try:
                        pct = min(100.0, max(0.0, (y / max(last_height, 1)) * 100.0))
                        self._set_progress(pct)
                    except Exception:
                        pass

                    time.sleep(jitter(SCROLL_PAUSE_MIN, SCROLL_PAUSE_MAX))

                    # If the document grew while we were scrolling, record that
                    new_h = doc_height()
                    if new_h > last_height:
                        last_height = new_h

                    # If we overshoot the bottom after a growth spurt, clamp and check again
                    if (y + viewport_h) >= (last_height - 10):
                        d.execute_script("window.scrollTo(0, arguments[0]);", last_height - viewport_h)
                        y = last_height - viewport_h
                        time.sleep(jitter(SCROLL_PAUSE_MIN, SCROLL_PAUSE_MAX))

            self._log("\n=== Summary (Thumbnails slow-scroll) ===")
            self._log(f"Saved thumbnails: {successes}")
            self._log(f"Errors          : {errors}")
            self._log(f"Folder          : {out_dir.resolve()}")

        except Exception as e:
            self._log(f"\nFatal error: {e}")
        finally:
            self.btn_start.configure(state="normal")
            self.btn_open.configure(state="normal")


    def _run_worker_pinpages(self, out_dir: Path):
        d = self.driver
        if not d:
            self._log("No browser available.")
            return

        successes = 0
        errors = 0
        skips = 0
        seen_links: Set[str] = set()
        idle = 0

        try:
            self._log("Streaming pin pages while scrolling…")
            try:
                WebDriverWait(d, 12).until(EC.presence_of_element_located((By.CSS_SELECTOR, "a[href*='/pin/']")))
            except Exception:
                self._log("Pins not visible yet—starting scroll loop anyway.")

            # Open a dedicated worker tab once
            d.switch_to.new_window("tab")
            self.worker_handle = d.current_window_handle
            # Switch back to the board to scroll
            d.switch_to.window(self.board_handle)

            # Indeterminate-style progress
            self._set_progress(0, 100)

            while not self.cancel_flag.is_set():
                # 1) Harvest currently visible NEW pin links
                new_links = self._collect_new_pin_links(d, seen_links)
                if new_links:
                    idle = 0
                    total_batch = len(new_links)
                    self._log(f"Found {total_batch} new pins in view…")
                    # 2) Visit each in worker tab and download
                    for href in new_links:
                        if self.cancel_flag.is_set():
                            break

                        pin_id = extract_pin_id_from_href(href)

                        try:
                            # Navigate in worker tab
                            d.switch_to.window(self.worker_handle)
                            d.get(href)

                            local_wait = WebDriverWait(d, PIN_WAIT_SECONDS)
                            img_url = get_image_url_from_pin_page(d, local_wait)
                            if (not img_url) or (".mp4" in img_url or ".m3u8" in img_url):
                                skips += 1
                                self._log(f"Skipped (video/no image) — {href}")
                            else:
                                if download_image(img_url, out_dir, pin_id):
                                    successes += 1
                                    self._log(f"Saved image ✓  (total={successes})")
                                else:
                                    errors += 1
                                    self._log("Download failed ✗")
                        except Exception as e:
                            errors += 1
                            self._log(f"Error: {e}")
                        finally:
                            # Back to the board to keep scrolling/collecting
                            try:
                                d.switch_to.window(self.board_handle)
                            except Exception:
                                break
                else:
                    idle += 1

                # 3) Scroll one page down to load more
                d.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                time.sleep(jitter(SCROLL_PAUSE_MIN, SCROLL_PAUSE_MAX))
                d.execute_script("window.scrollBy(0, -200);")
                time.sleep(0.25)

                if idle >= MAX_IDLE_SCROLLS:
                    break

            # Cleanup worker tab
            try:
                if self.worker_handle:
                    d.switch_to.window(self.worker_handle)
                    d.close()
                    d.switch_to.window(self.board_handle)
            except Exception:
                pass

            self._log("\n=== Summary (Pin pages streaming) ===")
            self._log(f"Saved images : {successes}")
            self._log(f"Skipped      : {skips}")
            self._log(f"Errors       : {errors}")
            self._log(f"Folder       : {out_dir.resolve()}")

        except Exception as e:
            self._log(f"\nFatal error: {e}")
        finally:
            self.btn_start.configure(state="normal")
            self.btn_open.configure(state="normal")


if __name__ == "__main__":
    app = PinterestDownloaderApp()
    app.mainloop()
