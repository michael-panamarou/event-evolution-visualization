# Chapter 1 - Introduction

## Motivation
Events such as traffic incidents, particle collisions, seismic activity, and fractal 
orbit steps share a common structure: a position in space and a point in time. While 
spatial visualization reveals where events occur, it fails to show how they evolve. 
This work addresses that gap.

## Problem Statement
Spatiotemporal event data is inherently four-dimensional, often dense, and highly 
domain-specific. Standard visualization tools lack the means to represent temporal 
evolution interactively in 3D. This thesis designs and implements techniques that 
treat space and time as jointly explorable dimensions.

## Scope and Delimitation
The thesis covers three event dataset types with 3D spatial and temporal components. 
Two overview visualizations and one local exploration technique are developed and 
implemented in a web-based interactive prototype. VR, real-time streaming, and 
ML-based analysis are out of scope.

## Contributions
- Systematic literature review on event visualization techniques
- Three representative datasets with a unified data format and conversion pipelines
- Two overview and one local exploration visualization technique
- Interactive web-based prototype built with Three.js, deck.gl, and React
- Quantitative and qualitative evaluation of the prototype

## Structure of the Thesis
The thesis follows a classical structure: theoretical foundations (Ch. 2), related 
work (Ch. 3), design (Ch. 4), implementation (Ch. 5), evaluation (Ch. 6), discussion 
(Ch. 7), and conclusion (Ch. 8).
