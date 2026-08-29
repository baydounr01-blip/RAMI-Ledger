//! rami-core: primitivas del Universo de Bloques Ramificados aplicado a una
//! cadena de bloques. Este núcleo contiene solo lo estable y verificable:
//! canonicalización, hashing, firmas y Merkle. Los módulos de consenso
//! (bloque, transacciones, PoW, fork-choice) se construyen encima.

pub mod canon;
pub mod crypto;
pub mod hashing;
pub mod ledger;
pub mod nn;
pub mod pow;
pub mod params;
pub mod tiebreak;
pub mod serdehex;
pub mod block;
pub mod tx;
pub mod state;
pub mod blocktree;
pub mod store;
