// 트레이 상태 스트립 렌더 — 로고 + $비용 + (상태점 + 라벨 + 잔여%) 를 RGBA 버퍼에 직접 그린다.
// macOS 트레이 타이틀은 일반 텍스트라 색을 못 입히므로 아이콘 이미지 전체를 교체하는 방식
// (스펙 §2). 폰트는 macOS 시스템 TTF 런타임 로드 — 실패 시 None, 호출부가 텍스트 타이틀로
// fallback 한다.

use fontdue::{Font, FontSettings};
use std::sync::OnceLock;

pub struct TrayItem {
    pub label: String, // "5h" | "7d" | "F"
    /// 사용률 % 0..100. 표시 숫자는 사용률(클로드 사용량 페이지와 동일 의미 — 2026-07-14
    /// 사용자 결정), 상태 점 색은 잔여(100-사용률) 기준 유지.
    pub used_pct: f64,
}

/// Retina 스케일. 실기기에서 아이콘이 너무 크게/흐리게 보이면 1 로 조정 (스펙 §2 리스크).
pub const SCALE: u32 = 2;
const BASE_H: u32 = 18; // 메뉴바 논리 높이(pt)
// 메뉴바가 이미지를 바 높이에 맞춰 축소하므로 폰트를 스트립 높이 대비 크게 잡아야
// 실표시 크기가 시스템 텍스트와 비슷해진다 (11pt 는 실기기에서 너무 작았음 — 2026-07-14).
const FONT_PT: f32 = 13.5;

pub const GREEN: [u8; 4] = [52, 199, 89, 255]; // systemGreen
pub const YELLOW: [u8; 4] = [255, 204, 0, 255]; // systemYellow
pub const RED: [u8; 4] = [255, 59, 48, 255]; // systemRed

pub fn dot_color(remaining_pct: f64) -> [u8; 4] {
    if remaining_pct >= 70.0 {
        GREEN
    } else if remaining_pct >= 30.0 {
        YELLOW
    } else {
        RED
    }
}

static FONT: OnceLock<Option<Font>> = OnceLock::new();

fn font() -> Option<&'static Font> {
    FONT.get_or_init(|| {
        let candidates = [
            "/System/Library/Fonts/Geneva.ttf",
            "/System/Library/Fonts/Monaco.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ];
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(f) = Font::from_bytes(bytes, FontSettings::default()) {
                    return Some(f);
                }
            }
        }
        None
    })
    .as_ref()
}

struct Canvas {
    buf: Vec<u8>,
    w: u32,
    h: u32,
}

impl Canvas {
    fn new(w: u32, h: u32) -> Self {
        Self { buf: vec![0; (w * h * 4) as usize], w, h }
    }

    /// 단순 over 알파 블렌딩 — 메뉴바 배경 위에 얹히므로 정밀 premultiply 불필요.
    fn blend(&mut self, x: i32, y: i32, color: [u8; 4], alpha: f32) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            return;
        }
        let a = (alpha.clamp(0.0, 1.0) * color[3] as f32) / 255.0;
        if a <= 0.0 {
            return;
        }
        let idx = ((y as u32 * self.w + x as u32) * 4) as usize;
        for c in 0..3 {
            let dst = self.buf[idx + c] as f32;
            self.buf[idx + c] = (color[c] as f32 * a + dst * (1.0 - a)).round() as u8;
        }
        let da = self.buf[idx + 3] as f32 / 255.0;
        self.buf[idx + 3] = ((a + da * (1.0 - a)) * 255.0).round() as u8;
    }

    fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, color: [u8; 4]) {
        let (x0, x1) = ((cx - r - 1.0) as i32, (cx + r + 1.0) as i32);
        let (y0, y1) = ((cy - r - 1.0) as i32, (cy + r + 1.0) as i32);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let d = (((x as f32 + 0.5) - cx).powi(2) + ((y as f32 + 0.5) - cy).powi(2)).sqrt();
                let alpha = (r - d + 0.5).clamp(0.0, 1.0); // 1px 안티앨리어스 에지
                self.blend(x, y, color, alpha);
            }
        }
    }
}

fn text_width(f: &Font, text: &str, px: f32) -> f32 {
    text.chars().map(|c| f.metrics(c, px).advance_width).sum()
}

fn draw_text(
    canvas: &mut Canvas,
    f: &Font,
    text: &str,
    x: f32,
    baseline: f32,
    px: f32,
    color: [u8; 4],
) -> f32 {
    let mut pen = x;
    for ch in text.chars() {
        let (m, bitmap) = f.rasterize(ch, px);
        let gx = (pen + m.xmin as f32) as i32;
        let gy = (baseline - (m.height as f32 + m.ymin as f32)) as i32;
        for row in 0..m.height {
            for col in 0..m.width {
                let cov = bitmap[row * m.width + col] as f32 / 255.0;
                canvas.blend(gx + col as i32, gy + row as i32, color, cov);
            }
        }
        pen += m.advance_width;
    }
    pen
}

/// 로고 RGBA 를 box-average 로 target 높이에 맞춰 축소 (비율 유지).
fn resize_rgba(src: &[u8], sw: u32, sh: u32, th: u32) -> (Vec<u8>, u32, u32) {
    let tw = ((sw as f32) * (th as f32) / (sh as f32)).round().max(1.0) as u32;
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for ty in 0..th {
        for tx in 0..tw {
            let x0 = (tx as f32 / tw as f32 * sw as f32) as u32;
            let x1 = ((((tx + 1) as f32) / tw as f32 * sw as f32).ceil() as u32).min(sw);
            let y0 = (ty as f32 / th as f32 * sh as f32) as u32;
            let y1 = ((((ty + 1) as f32) / th as f32 * sh as f32).ceil() as u32).min(sh);
            let (mut r, mut g, mut b, mut a, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for sy in y0..y1.max(y0 + 1) {
                for sx in x0..x1.max(x0 + 1) {
                    let i = ((sy * sw + sx) * 4) as usize;
                    r += src[i] as u32;
                    g += src[i + 1] as u32;
                    b += src[i + 2] as u32;
                    a += src[i + 3] as u32;
                    n += 1;
                }
            }
            let o = ((ty * tw + tx) * 4) as usize;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
            out[o + 3] = (a / n) as u8;
        }
    }
    (out, tw, th)
}

/// 상태 스트립 렌더. 반환 (rgba, w, h). 폰트 로드 실패 또는 items 비면 None.
pub fn render_status_strip(
    logo_rgba: Option<(&[u8], u32, u32)>,
    cost_text: Option<&str>,
    items: &[TrayItem],
    dark_menubar: bool,
) -> Option<(Vec<u8>, u32, u32)> {
    if items.is_empty() {
        return None;
    }
    let f = font()?;
    let h = BASE_H * SCALE;
    let px = FONT_PT * SCALE as f32;
    // 알파를 낮추면 밝은 배경화면 위에서 흐릿해진다 — 불투명이 가독성에 유리.
    let text_color: [u8; 4] = if dark_menubar {
        [255, 255, 255, 255]
    } else {
        [0, 0, 0, 255]
    };
    let dot_r = 3.5 * SCALE as f32;
    let gap = 5.0 * SCALE as f32;
    let sep = 9.0 * SCALE as f32;

    // 1) 폭 측정
    let logo = logo_rgba.map(|(buf, w0, h0)| resize_rgba(buf, w0, h0, h));
    let mut w = 0.0f32;
    if let Some((_, lw, _)) = &logo {
        w += *lw as f32 + gap;
    }
    if let Some(cost) = cost_text {
        w += text_width(f, cost, px) + sep;
    }
    for (i, item) in items.iter().enumerate() {
        w += dot_r * 2.0 + gap * 0.6;
        w += text_width(f, &item_text(item), px);
        if i + 1 < items.len() {
            w += sep;
        }
    }
    let w = (w.ceil() as u32).max(1);

    // 2) 드로잉
    let mut canvas = Canvas::new(w, h);
    let baseline = h as f32 * 0.72;
    let dot_cy = h as f32 * 0.52;
    let mut pen = 0.0f32;
    if let Some((buf, lw, lh)) = &logo {
        for y in 0..*lh {
            for x in 0..*lw {
                let i = ((y * lw + x) * 4) as usize;
                canvas.blend(
                    x as i32,
                    y as i32,
                    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]],
                    1.0,
                );
            }
        }
        pen += *lw as f32 + gap;
    }
    if let Some(cost) = cost_text {
        pen = draw_text(&mut canvas, f, cost, pen, baseline, px, text_color) + sep;
    }
    for (i, item) in items.iter().enumerate() {
        canvas.fill_circle(pen + dot_r, dot_cy, dot_r, dot_color(100.0 - item.used_pct));
        pen += dot_r * 2.0 + gap * 0.6;
        pen = draw_text(&mut canvas, f, &item_text(item), pen, baseline, px, text_color);
        if i + 1 < items.len() {
            pen += sep;
        }
    }
    Some((canvas.buf, w, h))
}

fn item_text(item: &TrayItem) -> String {
    format!("{} {}", item.label, item.used_pct.round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // macOS 시스템 폰트가 있는 환경에서만 의미 있는 스모크 테스트.
    #[cfg(target_os = "macos")]
    #[test]
    fn renders_strip_with_expected_height() {
        let items = vec![
            TrayItem { label: "5h".into(), used_pct: 8.0 },
            TrayItem { label: "7d".into(), used_pct: 42.0 },
            TrayItem { label: "F".into(), used_pct: 78.0 },
        ];
        let (buf, w, h) =
            render_status_strip(None, Some("$12"), &items, true).expect("font should load");
        assert_eq!(h, 18 * SCALE);
        assert!(w > 50 * SCALE, "strip too narrow: {w}");
        assert_eq!(buf.len(), (w * h * 4) as usize);
        // 무언가 그려졌는지 — 완전 투명이 아니어야 한다.
        assert!(buf.chunks(4).any(|p| p[3] > 0));
    }

    #[test]
    fn returns_none_for_empty_items() {
        assert!(render_status_strip(None, Some("$12"), &[], true).is_none());
    }

    #[test]
    fn dot_color_matches_thresholds() {
        assert_eq!(dot_color(92.0), GREEN);
        assert_eq!(dot_color(70.0), GREEN);
        assert_eq!(dot_color(69.9), YELLOW);
        assert_eq!(dot_color(30.0), YELLOW);
        assert_eq!(dot_color(29.9), RED);
    }
}
