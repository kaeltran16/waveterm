use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub struct EstartInfo {
    pub ws: String,
    pub web: String,
    pub version: String,
    pub buildtime: i64,
}

// Mirrors emain/emain-wavesrv.ts:110 — matches the ESTART line wavesrv prints on stderr.
pub fn parse_estart(line: &str) -> Option<EstartInfo> {
    let re = Regex::new(r"WAVESRV-ESTART ws:([a-z0-9.:]+) web:([a-z0-9.:]+) version:([a-z0-9.-]+) buildtime:(\d+)").ok()?;
    let caps = re.captures(line)?;
    Some(EstartInfo {
        ws: caps[1].to_string(),
        web: caps[2].to_string(),
        version: caps[3].to_string(),
        buildtime: caps[4].parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_estart_line() {
        let line = "WAVESRV-ESTART ws:127.0.0.1:61269 web:127.0.0.1:61270 version:0.11.0-beta.1 buildtime:1719240000";
        let info = parse_estart(line).expect("should parse");
        assert_eq!(info.ws, "127.0.0.1:61269");
        assert_eq!(info.web, "127.0.0.1:61270");
        assert_eq!(info.version, "0.11.0-beta.1");
        assert_eq!(info.buildtime, 1719240000);
    }

    #[test]
    fn ignores_event_lines() {
        assert_eq!(parse_estart("WAVESRV-EVENT:{\"foo\":1}"), None);
    }

    #[test]
    fn ignores_plain_log_lines() {
        assert_eq!(parse_estart("some random log output"), None);
    }
}
