//! rami-core: primitivas del Universo de Bloques Ramificados aplicado a una
//! cadena de bloques. Este núcleo contiene solo lo estable y verificable:
//! canonicalización, hashing, firmas y Merkle. Los módulos de consenso
//! (bloque, transacciones, PoW, fork-choice) se construyen encima.

pub mod canon;
pub mod crypto;
pub mod hashing;
pub mod ledger;
