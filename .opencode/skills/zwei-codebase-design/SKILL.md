---
name: zwei-codebase-design
description: Helps design Zwei modules, small interfaces, clean seams, adapters, and behavior-focused testability.
---

# Zwei Codebase Design

Load when deciding module placement, interface shape, refactoring boundaries, adapters, or test seams. Use with `zwei-architecture`; it does not replace DDD or hexagonal boundaries.

## Vocabulary

- **Module:** a unit with an interface and implementation, from a function/component through a Go package or Angular feature.
- **Interface:** what a caller must know: types, invariants, ordering/lifecycle, errors, configuration, and relevant performance behavior.
- **Depth:** useful capability per amount of interface a caller must learn. Prefer cohesive modules that hide complexity behind a small interface over pass-through wrappers.
- **Seam:** a place where behavior can vary without editing its caller. A seam is not automatically a bounded context or a reason to add an interface.
- **Adapter:** a concrete implementation at a boundary, such as PostgreSQL, Redis, HTTP/WebSocket, browser storage, or browser media.
- **Locality:** how much of a change or fix remains concentrated in one place; **leverage:** how much useful behavior one implementation provides to callers.

## Design questions

- Can the module hide more cohesive behavior with a smaller, clearer interface?
- If this module disappeared, would complexity disappear or spread across callers? The latter may indicate a useful boundary; the former may indicate a needless layer.
- Does behavior genuinely vary at this seam, or is an interface being added only for hypothetical substitution?
- Are domain/application policies separated from SQL, HTTP/WebSocket, Angular, and other infrastructure details?
- Can tests exercise the same meaningful interface real callers rely on, with deterministic fakes only at true I/O or variation boundaries?
- Does the proposed boundary preserve ownership of cancellation, subscriptions, goroutines, browser media, and other resources?

Ports belong with the consuming application/use-case layer in Go. Angular transport and stateful browser adapters remain injected services/facades with deliberate lifecycle scope. Keep domain rules in their owning bounded context. Avoid layers for vocabulary alone; apply KISS/YAGNI and state the trade-off before changing architecture.

This is a design and review lens, not a directive to refactor. For broad architectural surveys, do not turn every observation into a task; identify the smallest valuable opportunity and get scope agreed first.
