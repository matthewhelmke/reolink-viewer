pub fn format_number(n: u64) -> String {
    itoa::Buffer::new().format(n).to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats() {
        assert_eq!(super::format_number(42), "42");
    }
}
