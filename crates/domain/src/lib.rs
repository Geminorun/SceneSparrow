#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub title: String,
    pub working_revision: i64,
    pub approved_baseline: Option<i64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Project title must contain 1 to 120 characters")]
pub struct InvalidTitle;

pub fn normalize_title(title: &str) -> Result<String, InvalidTitle> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 || title.chars().any(char::is_control) {
        return Err(InvalidTitle);
    }
    Ok(title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_unicode_titles_and_rejects_invalid_content() {
        assert_eq!(normalize_title("  幕雀 Demo  ").unwrap(), "幕雀 Demo");
        assert!(normalize_title(&"雀".repeat(120)).is_ok());
        for value in [" ".to_owned(), "x".repeat(121), "bad\ntitle".to_owned()] {
            assert!(normalize_title(&value).is_err());
        }
    }
}

pub mod contracts;
pub mod manuscript;

pub mod ai;

pub mod planning;

pub mod review;

pub mod exports;
