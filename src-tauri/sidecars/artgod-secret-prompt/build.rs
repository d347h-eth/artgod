use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

const ASCII_START: i32 = 0x20;
const ASCII_END: i32 = 0x7e;
const INPUT_FONT_PATH: &str = "assets/fonts/cozettecrossedseven_hidpi.bdf";
const LICENSE_PATH: &str = "assets/fonts/Cozette-LICENSE.txt";
const OUTPUT_FONT_PATH: &str = "generated_font.rs";
const CANONICAL_COPYRIGHT_NOTICE: &str = "Copyright (c) 2020 Samhain <samhain@moonwit.ch> & contributors <https://github.com/the-moonwitch/Cozette/contributors>";

fn main() -> Result<(), Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let input_path = manifest_dir.join(INPUT_FONT_PATH);
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let output_path = out_dir.join(OUTPUT_FONT_PATH);

    println!("cargo:rerun-if-changed={INPUT_FONT_PATH}");

    let bdf = fs::read_to_string(&input_path)?;
    let font = parse_bdf(&bdf)?;
    let rust_source = render_rust_module(&font, path_for_comment(&manifest_dir, &input_path));

    fs::write(output_path, rust_source)?;
    Ok(())
}

fn path_for_comment(manifest_dir: &Path, input_path: &Path) -> String {
    input_path
        .strip_prefix(manifest_dir)
        .unwrap_or(input_path)
        .display()
        .to_string()
}

#[derive(Clone, Copy)]
struct BoundingBox {
    width: i32,
    height: i32,
    x: i32,
    y: i32,
}

struct CurrentGlyph {
    name: String,
    encoding: Option<i32>,
    dwidth: Option<i32>,
    bbx: Option<BoundingBox>,
    bitmap_rows: Vec<String>,
}

struct Glyph {
    name: String,
    dwidth: i32,
    bbx: BoundingBox,
    bitmap_rows: Vec<String>,
}

struct ProjectedGlyph {
    advance_width: i32,
    rows: Vec<u32>,
}

struct FontData {
    font_name: String,
    font_bounding_box: BoundingBox,
    copyright: String,
    ascii_glyphs: Vec<ProjectedGlyph>,
    max_advance_width: i32,
}

fn parse_bdf(source: &str) -> Result<FontData, Box<dyn Error>> {
    let mut font_name: Option<String> = None;
    let mut font_bounding_box: Option<BoundingBox> = None;
    let mut font_ascent: Option<i32> = None;
    let mut font_descent: Option<i32> = None;
    let mut copyright: Option<String> = None;
    let mut glyphs = BTreeMap::new();
    let mut current: Option<CurrentGlyph> = None;
    let mut in_bitmap = false;

    for line in source.lines() {
        if let Some(value) = line.strip_prefix("FONT ") {
            font_name = Some(value.trim().to_owned());
            continue;
        }
        if let Some(value) = line.strip_prefix("FONTBOUNDINGBOX ") {
            let parts = parse_numbers(value, 4)?;
            font_bounding_box = Some(BoundingBox {
                width: parts[0],
                height: parts[1],
                x: parts[2],
                y: parts[3],
            });
            continue;
        }
        if let Some(value) = line.strip_prefix("FONT_ASCENT ") {
            font_ascent = Some(value.trim().parse()?);
            continue;
        }
        if let Some(value) = line.strip_prefix("FONT_DESCENT ") {
            font_descent = Some(value.trim().parse()?);
            continue;
        }
        if let Some(value) = line.strip_prefix("COPYRIGHT ") {
            copyright = Some(value.trim().trim_matches('"').to_owned());
            continue;
        }

        if let Some(value) = line.strip_prefix("STARTCHAR ") {
            current = Some(CurrentGlyph {
                name: value.trim().to_owned(),
                encoding: None,
                dwidth: None,
                bbx: None,
                bitmap_rows: Vec::new(),
            });
            in_bitmap = false;
            continue;
        }

        let Some(glyph) = current.as_mut() else {
            continue;
        };

        if let Some(value) = line.strip_prefix("ENCODING ") {
            glyph.encoding = Some(value.trim().parse()?);
            continue;
        }
        if let Some(value) = line.strip_prefix("DWIDTH ") {
            glyph.dwidth = Some(
                value
                    .split_whitespace()
                    .next()
                    .ok_or("DWIDTH line was empty")?
                    .parse()?,
            );
            continue;
        }
        if let Some(value) = line.strip_prefix("BBX ") {
            let parts = parse_numbers(value, 4)?;
            glyph.bbx = Some(BoundingBox {
                width: parts[0],
                height: parts[1],
                x: parts[2],
                y: parts[3],
            });
            continue;
        }
        if line == "BITMAP" {
            in_bitmap = true;
            continue;
        }
        if line == "ENDCHAR" {
            let finished = current.take().ok_or("Missing glyph state at ENDCHAR")?;
            let encoding = finished
                .encoding
                .ok_or_else(|| format!("Incomplete glyph entry for {}", finished.name))?;
            glyphs.insert(
                encoding,
                Glyph {
                    name: finished.name,
                    dwidth: finished
                        .dwidth
                        .ok_or("Incomplete glyph entry: dwidth was missing")?,
                    bbx: finished
                        .bbx
                        .ok_or("Incomplete glyph entry: bbx was missing")?,
                    bitmap_rows: finished.bitmap_rows,
                },
            );
            in_bitmap = false;
            continue;
        }
        if in_bitmap {
            glyph.bitmap_rows.push(line.trim().to_owned());
        }
    }

    let font_bounding_box = font_bounding_box.ok_or("Missing required BDF FONTBOUNDINGBOX")?;
    let font_name = font_name.ok_or("Missing required BDF FONT")?;
    let _font_ascent = font_ascent.ok_or("Missing required BDF FONT_ASCENT")?;
    let _font_descent = font_descent.ok_or("Missing required BDF FONT_DESCENT")?;

    let mut ascii_glyphs = Vec::new();
    for code in ASCII_START..=ASCII_END {
        let glyph = glyphs
            .get(&code)
            .ok_or_else(|| format!("Missing glyph for ASCII code {code}"))?;
        ascii_glyphs.push(project_glyph(font_bounding_box, glyph)?);
    }

    let max_advance_width = ascii_glyphs
        .iter()
        .map(|glyph| glyph.advance_width)
        .max()
        .ok_or("ASCII glyph set was empty")?;

    Ok(FontData {
        font_name,
        font_bounding_box,
        copyright: copyright.unwrap_or_default(),
        ascii_glyphs,
        max_advance_width,
    })
}

fn parse_numbers(raw: &str, count: usize) -> Result<Vec<i32>, Box<dyn Error>> {
    let parts: Vec<i32> = raw
        .split_whitespace()
        .map(str::parse)
        .collect::<Result<Vec<_>, _>>()?;
    if parts.len() < count {
        return Err(format!("Invalid numeric line: {raw}").into());
    }
    Ok(parts.into_iter().take(count).collect())
}

fn project_glyph(
    font_bounding_box: BoundingBox,
    glyph: &Glyph,
) -> Result<ProjectedGlyph, Box<dyn Error>> {
    if font_bounding_box.width > 32 {
        return Err("Font width exceeds 32 bits and cannot fit into u32 rows".into());
    }

    let mut rows = vec![0u32; font_bounding_box.height as usize];
    let x_start = glyph.bbx.x - font_bounding_box.x;
    let bottom_offset = glyph.bbx.y - font_bounding_box.y;
    let y_top = font_bounding_box.height - (bottom_offset + glyph.bbx.height);

    if glyph.bitmap_rows.len() != glyph.bbx.height as usize {
        return Err(format!(
            "Glyph {} expected {} bitmap rows, got {}",
            glyph.name,
            glyph.bbx.height,
            glyph.bitmap_rows.len()
        )
        .into());
    }

    for (row_index, bitmap_row) in glyph.bitmap_rows.iter().enumerate() {
        let projected_y = y_top + row_index as i32;
        if projected_y < 0 || projected_y >= font_bounding_box.height {
            return Err(format!("Glyph {} row overflowed projected font cell", glyph.name).into());
        }

        let total_bits = bitmap_row.len() * 4;
        let raw_value = if bitmap_row.is_empty() {
            0u64
        } else {
            u64::from_str_radix(bitmap_row, 16)?
        };
        let shift = total_bits.saturating_sub(glyph.bbx.width as usize);
        let trimmed = raw_value >> shift;

        let mut projected_row = 0u32;
        for bit_index in 0..glyph.bbx.width {
            let source_shift = glyph.bbx.width - 1 - bit_index;
            let pixel_on = ((trimmed >> source_shift) & 1) == 1;
            if !pixel_on {
                continue;
            }
            let projected_x = x_start + bit_index;
            if projected_x < 0 || projected_x >= font_bounding_box.width {
                return Err(
                    format!("Glyph {} column overflowed projected font cell", glyph.name).into(),
                );
            }
            projected_row |= 1u32 << projected_x;
        }

        rows[projected_y as usize] = projected_row;
    }

    Ok(ProjectedGlyph {
        advance_width: glyph.dwidth,
        rows,
    })
}

fn render_rust_module(font: &FontData, input_relative_path: String) -> String {
    let mut rust = String::new();
    let _ = writeln!(
        rust,
        "// Generated by build.rs from {input_relative_path}\n// Source font: {}\n// Source font metadata COPYRIGHT: {}\n// Licensed under MIT. See {LICENSE_PATH}.\n// Canonical upstream copyright notice:\n// {CANONICAL_COPYRIGHT_NOTICE}\n",
        font.font_name, font.copyright
    );
    let _ = writeln!(rust, "pub const ASCII_START: u8 = {ASCII_START};");
    let _ = writeln!(rust, "pub const ASCII_END: u8 = {ASCII_END};");
    let _ = writeln!(
        rust,
        "pub const ASCII_GLYPH_COUNT: usize = {};",
        (ASCII_END - ASCII_START + 1)
    );
    let _ = writeln!(
        rust,
        "pub const CELL_WIDTH: usize = {};",
        font.font_bounding_box.width
    );
    let _ = writeln!(
        rust,
        "pub const CELL_HEIGHT: usize = {};",
        font.font_bounding_box.height
    );
    let _ = writeln!(
        rust,
        "pub const ADVANCE_WIDTH: usize = {};",
        font.max_advance_width
    );
    let _ = writeln!(
        rust,
        "\npub static ASCII_GLYPHS: [[u32; CELL_HEIGHT]; ASCII_GLYPH_COUNT] = ["
    );
    for glyph in &font.ascii_glyphs {
        let rendered_rows = glyph
            .rows
            .iter()
            .map(|row| format!("0x{row:08X}"))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = writeln!(rust, "    [{rendered_rows}],");
    }
    let _ = writeln!(rust, "];");
    rust
}
