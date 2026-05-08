pub mod amux {
    include!(concat!(env!("OUT_DIR"), "/amux.rs"));
}

pub mod teamclaw {
    include!(concat!(env!("OUT_DIR"), "/teamclaw.rs"));
}

use prost::Message;

macro_rules! impl_encode {
    ($($t:ty),*) => {
        $(impl $t {
            pub fn encode_to_vec(&self) -> Vec<u8> {
                let mut buf = Vec::with_capacity(self.encoded_len());
                self.encode(&mut buf).expect(concat!("encode ", stringify!($t)));
                buf
            }
        })*
    };
}

impl_encode!(amux::Envelope, amux::DeviceState, amux::RuntimeInfo);
impl_encode!(
    teamclaw::SessionMessageEnvelope,
    teamclaw::LiveEventEnvelope,
    teamclaw::RpcRequest,
    teamclaw::RpcResponse
);
