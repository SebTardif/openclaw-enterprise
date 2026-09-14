//! Reject nonpublic IPv4 destinations from broker admission.
use std::net::Ipv4Addr;

fn in_network(ip: Ipv4Addr, base: Ipv4Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    u32::from(ip) & mask == u32::from(base) & mask
}
pub(crate) fn public_ipv4(ip: Ipv4Addr) -> bool {
    const SPECIAL: &[(u32, u8)] = &[
        (0x00000000, 8),
        (0x0a000000, 8),
        (0x64400000, 10),
        (0x7f000000, 8),
        (0xa9fe0000, 16),
        (0xac100000, 12),
        (0xc0000000, 24),
        (0xc0000200, 24),
        (0xc0586300, 24),
        (0xc0a80000, 16),
        (0xc6120000, 15),
        (0xc6336400, 24),
        (0xcb007100, 24),
        (0xe0000000, 4),
        (0xf0000000, 4),
    ];
    !SPECIAL
        .iter()
        .any(|(base, prefix)| in_network(ip, Ipv4Addr::from(*base), *prefix))
}
