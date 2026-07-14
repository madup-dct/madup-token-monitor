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
pub const ORANGE: [u8; 4] = [255, 149, 0, 255]; // systemOrange (40~70% 잔여)
pub const RED: [u8; 4] = [255, 59, 48, 255]; // systemRed

/// 잔여 기준 3단계 상태색 — 앱(quotaSignal)과 동일 임계값 (≥70 여유 / ≥40 주의 / <40 위험).
pub fn band_color(remaining_pct: f64) -> [u8; 4] {
    if remaining_pct >= 70.0 {
        GREEN
    } else if remaining_pct >= 40.0 {
        ORANGE
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

    /// 안티앨리어스 rounded rect (SDF). x,y = 좌상단, r = 코너 반경. 배터리 셀 렌더용.
    fn fill_round_rect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, color: [u8; 4]) {
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
        let (cx, cy) = (x + w / 2.0, y + h / 2.0);
        let (hx, hy) = (w / 2.0, h / 2.0);
        let x0 = (x - 1.0).floor() as i32;
        let x1 = (x + w + 1.0).ceil() as i32;
        let y0 = (y - 1.0).floor() as i32;
        let y1 = (y + h + 1.0).ceil() as i32;
        for py in y0..y1 {
            for px in x0..x1 {
                let dx = ((px as f32 + 0.5) - cx).abs() - (hx - r);
                let dy = ((py as f32 + 0.5) - cy).abs() - (hy - r);
                let outside = (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt() - r;
                let inside = dx.max(dy).min(0.0);
                let cov = (0.5 - (outside + inside)).clamp(0.0, 1.0);
                self.blend(px, py, color, cov);
            }
        }
    }
}

/// 배터리 셀 총 폭 (body + nub). 폭 측정과 드로잉이 같은 값을 쓰도록 단일 소스.
fn battery_width(bat_h: f32) -> f32 {
    bat_h * 1.9 + bat_h * 0.28
}

/// 배터리 모양 레벨 표시 — 옆 메뉴바 아이콘과 톤을 맞추려 아이콘형(중립 트랙 + 상태색 채움).
/// track(빈 부분) 위에 usage 만큼 fill 을 채우고 오른쪽에 nub. fill 색은 잔여 기준 상태색.
fn draw_battery(
    canvas: &mut Canvas,
    x: f32,
    y: f32,
    bat_h: f32,
    usage_frac: f32,
    track: [u8; 4],
    fill: [u8; 4],
) {
    let body_w = bat_h * 1.9;
    let r = bat_h * 0.3;
    canvas.fill_round_rect(x, y, body_w, bat_h, r, track);
    let fw = (body_w * usage_frac.clamp(0.0, 1.0)).min(body_w);
    if fw > 0.5 {
        canvas.fill_round_rect(x, y, fw, bat_h, r.min(fw * 0.5), fill);
    }
    let nub_w = bat_h * 0.2;
    let nub_h = bat_h * 0.5;
    canvas.fill_round_rect(
        x + body_w + bat_h * 0.06,
        y + (bat_h - nub_h) / 2.0,
        nub_w,
        nub_h,
        nub_w * 0.4,
        track,
    );
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

/// 텍스트 + 대비 외곽선(halo).
/// 메뉴바 배경은 벽지 틴트가 섞여 밝기가 제각각 — 단색 텍스트는 중간톤 배경에서
/// 회색처럼 묻힌다 (2026-07-14 실기기 피드백). 반대색 halo 로 어떤 배경에서도 또렷하게.
fn draw_text_with_halo(
    canvas: &mut Canvas,
    f: &Font,
    text: &str,
    x: f32,
    baseline: f32,
    px: f32,
    color: [u8; 4],
    halo: [u8; 4],
) -> f32 {
    let o = SCALE as f32 * 0.75;
    for (dx, dy) in [
        (-o, 0.0),
        (o, 0.0),
        (0.0, -o),
        (0.0, o),
        (-o, -o),
        (o, -o),
        (-o, o),
        (o, o),
    ] {
        draw_text(canvas, f, text, x + dx, baseline + dy, px, halo);
    }
    draw_text(canvas, f, text, x, baseline, px, color)
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
    // 본문은 불투명 + 반대색 halo — 벽지 틴트가 섞인 메뉴바에서도 가독성 확보.
    let (text_color, halo_color): ([u8; 4], [u8; 4]) = if dark_menubar {
        ([255, 255, 255, 255], [0, 0, 0, 150])
    } else {
        ([0, 0, 0, 255], [255, 255, 255, 170])
    };
    let gap = 5.0 * SCALE as f32; // 로고↔본문
    let label_gap = 3.0 * SCALE as f32; // 라벨↔배터리
    let sep = 8.0 * SCALE as f32; // 항목 간
    let bat_h = h as f32 * 0.5;
    let bat_w = battery_width(bat_h);
    let bat_y = (h as f32 - bat_h) / 2.0;
    // 배터리 빈 트랙은 텍스트색의 중립 저채도 — 옆 메뉴바 아이콘과 톤 통일.
    let track_color = [text_color[0], text_color[1], text_color[2], 64];

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
        w += text_width(f, &item.label, px) + label_gap + bat_w;
        if i + 1 < items.len() {
            w += sep;
        }
    }
    // halo·배터리 nub 가 오른쪽으로 삐져나올 수 있어 여유 폭 확보.
    let w = (w.ceil() as u32 + 2 * SCALE).max(1);

    // 2) 드로잉
    let mut canvas = Canvas::new(w, h);
    let baseline = h as f32 * 0.72;
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
        pen = draw_text_with_halo(&mut canvas, f, cost, pen, baseline, px, text_color, halo_color)
            + sep;
    }
    for (i, item) in items.iter().enumerate() {
        pen = draw_text_with_halo(
            &mut canvas,
            f,
            &item.label,
            pen,
            baseline,
            px,
            text_color,
            halo_color,
        ) + label_gap;
        let usage = (item.used_pct / 100.0).clamp(0.0, 1.0) as f32;
        // fill 색은 잔여(100-사용률) 기준 상태색.
        let fill = band_color(100.0 - item.used_pct);
        draw_battery(&mut canvas, pen, bat_y, bat_h, usage, track_color, fill);
        pen += bat_w;
        if i + 1 < items.len() {
            pen += sep;
        }
    }
    Some((canvas.buf, w, h))
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
    fn band_color_matches_thresholds() {
        // 잔여 기준: ≥70 green / 40~70 orange / <40 red.
        assert_eq!(band_color(92.0), GREEN);
        assert_eq!(band_color(70.0), GREEN);
        assert_eq!(band_color(69.9), ORANGE);
        assert_eq!(band_color(40.0), ORANGE);
        assert_eq!(band_color(39.9), RED);
    }
}
