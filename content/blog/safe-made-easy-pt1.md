---
title: "Safe Made Easy Pt.1: Single Ownership is (Not) Optional"
date: 2026-05-26
categories: ["plt"]
url: /safe-made-easy-pt1.html
---

- [Intro](#intro)
- [What it promises and what it doesn't](#what-it-promises-and-what-it-doesnt)
- [Motivating example](#motivating-example)
- [The proposal](#the-proposal)
- [Linear drops](#linear-drops)
- [The formal background](#the-formal-background)
- [The rules so far](#the-rules-so-far)
- [Conclusion](#conclusion)

## Intro

This post introduces an approach to memory safety that I believe is more practical and more ergonomic than the available alternatives.

It all started way back when, and was inspired by things I read and wrote:

- Attempts to bolt linear types on top of Rust [(1)](https://faultlore.com/blah/linear-rust/), [(2)](https://blog.yoshuawuyts.com/linearity-and-control/)
- [Leakpocalypse](https://faultlore.com/blah/everyone-poops/)
- Verdagon's post on [Vale design and higher RAII](https://verdagon.dev/blog/higher-raii-uses-linear-types)
- A lot, and I mean A LOT, of TypeScript

Three years of development later, I believe I finally got it. The proposal is complete.

Moreover, I have implemented it in my own programming language I intend to release soon-ish, and I want to share the design decisions and the entire path from "huh, why not" to "omg it's live".

So, TL;DR: linear types (which are dropped exactly once) + abstract interpretation + a bunch of tricks allows us to eliminate the same classes of bugs as Rust does (at least in non-concurrent environments) _plus_ memory leaks, and we can extend the approach to _also_ cover concurrent environments, all the while being _more_ ergonomic and less restrictive.

Sounds fun? Let's dig in.

## What it promises and what it doesn't

- It is _safe_ - it completely eliminates entire classes of bugs, such as:

  - Double-free
  - Use-after-free
  - Dangling pointers
  - Null pointer dereferences
  - Buffer overflows
  - Out-of-bounds accesses
  - Iterator invalidation
  - Uninitialized memory access
  - Memory leaks

  Single ownership enables linearity - each value is dropped exactly once - and prohibits ownership cycles. Together with the flow-sensitive type system built to enforce it, these eliminate most of the above. Buffer overflows and OOB accesses are covered separately, but the mechanics of the rest of the system make dealing with these easy and efficient.

- It is _sound_ - I will demonstrate over the course of this series that the claims hold for arbitrary inputs. There are no holes that can be used to break the guarantees provided from inside the system.

- It is **NOT** simple - there is a fairly large number of primitives working together so that the whole system can uphold the safety guarantees promised.

- It is **NOT** concerned with concurrency - though the "fearless concurrency" guarantees are a natural extension to the proposed system, it has not been implemented in a complete enough way to demonstrate the viability of the approach. I will expand on this in a future post once I get it up and running.

- It is **NOT** claiming to be "zero cost", though it keeps runtime overhead to the minimum - it introduces runtime checks (a single branch per indeterminate access) if the compiler cannot statically prove availability.

## Motivating example

Consider this pseudocode:

```
var x: T = new T;
if random() > 0.5 {
    drop x;
}
print(x);
```

What this code does is it _conditionally_ consumes a value.

There are two ways this could go in a real language. C++ doesn't particularly care and will happily compile this code:

```c++
#include <cstdlib>
#include <cstdio>
int main() {
    int *i = new int(42);

    if ((double)rand() / RAND_MAX > 0.5) {
        delete i;
    }

    printf("i=%d\n", *i);
    return 0;
}
```

Which will then proceed to invoke UB in about 50% of runs. A modern C++ developer would reach for `std::unique_ptr` and `std::optional` here - and they would help, partially. RAII via smart pointers eliminates the manual `delete`, and `optional` gives you a way to represent "maybe moved." But `unique_ptr` only manages heap-allocated objects, and the type system does not _enforce_ the optional check - `operator*` on an empty optional is undefined behavior, and even `.value()` only gives you a runtime exception instead of a compile-time error. It is still on you to remember.

In Rust, though, this code does not compile at all:

```rust
fn main() {
    let x = Box::new(42);
    if rand::random::<f64>() > 0.5 {
        drop(x);
    }
    println!("{}", x); // error[E0382]: borrow of moved value: `x`
}
```

Rust takes a very different approach. The compiler tracks moves through control flow - it sees that `x` _might_ have been moved in the `if` branch, and rejects the program outright. Rust's ownership model requires that every variable's move state is statically known at every point in the program - a conditionally-moved value violates that requirement, so the program is rejected. You _can_ wrap the value in `Option<T>` yourself and `.take()` it manually, but Rust won't do that for you - the burden is on the developer to restructure the code upfront.

So, what if there was a third way between these two?

## The proposal

The proposed solution is straightforward:

```
var x: T = new T;
if rand() > 0.5f {
    drop x;
}
// <- At this point, typeof(x) is Option<T>
```

The type of the value is now control-flow-dependent - the compiler evaluates it as it goes through the program, _widening_ it each time control flow diverges to accommodate for _both_ possibilities. Then it becomes the developer responsibility to _narrow_ it down when they want to use it:

```
var x: T = new T;
if rand() > 0.5f {
    drop x;
}   // x is _widened_ to an Option<T>
if x {
    // x is definitely available in this branch and can be used
} else {
    // x is definitely not available
}   // x is _widened_ to an Option<T> again
```

One way to view this is to consider which information is available at the compiler at various points:

- First conditional statement makes the compiler _lose_ information on availability of `x`, which is expressed by the type system as widening type of `x` to `Option<T>`
- Second conditional statement provides information to the compiler - in each branch of the statement, `x` has a definite availability
- But after the second conditional statement we are back to the state where the information is not available

Compared to C++ approach, we now force the developer to consider the state space explicitly and avoid the crash, because the typechecker will catch all attempts to use an `Option<T>` where a `T` should be used, or to use a definitely non-available value.

Compared to Rust approach, we gain flexibility at a cost of a runtime check - a single null/tag comparison at the point of refinement.

It should be noted that this is not a new idea. If anything, one of the most popular languages in the world, TypeScript, does exactly that. However, TypeScript compiles to JavaScript - a language with garbage collection and shared ownership, which does not concern itself with lifetimes, memory or resource management issues, or concurrency, which are all something I need to cover.

This is just the tip of the iceberg, the very beginning of the system. When we cover more ground - aggregates, references, function calls, dynamic dispatch, lambdas and closures - it will grow to accommodate new requirements.

## Linear drops

One more thing that I also wanted is that each value is guaranteed to be dropped exactly once. This is known as _linear typing_. When linear typing is discussed, the guarantee is usually formulated as "used exactly once", but what constitutes a _use_ can vary. In my case, use == drop.

With the proposed approach it becomes trivially simple:

- If a value is of an owned type `T`, it is being dropped when it is either going out of scope or its owner is going out of scope, or manually - which transitions its type to `None`
- If a value has an indeterminate availability - i.e. it is of type `Option<T>` where `T` is an owned type - the compiler inserts a runtime check and a conditional drop instead at the end of the scope, but these can also be dropped manually

This raises a question about the refined branch:

```
var x: T = new T;
if rand() > 0.5f {
    drop x;
}   // x is _widened_ to an Option<T>
if x {
    // x is definitely available in this branch and can be used,
    // but what type is it?
} else {
    // x is None
}   // x is _widened_ to an Option<T> again
```

Which type, exactly, will `x` have when it is refined to something available in the second conditional statement?

If it's refined to `T`, it will be dropped at the end of the scope of the `if` branch. That would be silly - a given value could only ever be refined once, used, then immediately dropped when the branch ends. Safe, but draconian.

Instead, we define a new type - `Some<T>` - whose only purpose is to _avoid_ being dropped, or to serve as _proof of availability without taking ownership_.

This is one of the many types that are handled by the type checker in a special way; namely:

- It is not automatically dropped when it goes out of scope - that's the whole point
- It cannot be constructed except by refining an `Option<T>` - constructing it from a `T` would move ownership in, and since `Some<T>` is not auto-dropped, the value would leak
- It is _dependent_ on the original `Option<T>` - if the value contained in the unwrapped `Option<T>` is somehow dropped, the refined view of that option should not be usable. I will cover dependencies and how they help us in a later post
- Conversely, explicitly dropping the `Option<T>` invalidates the `Some<T>` - the dependency is bidirectional
- It can be freely used in all the same places as `T`. The developer can explicitly drop it - this consumes the underlying value and sets the original `Option<T>` to `None`

As I said - definitely _not_ simple. But not that complicated either.

## The formal background

The approach described above has roots in several well-established areas of programming language theory.

**Flow-sensitive typing** allows the type of a variable to change as the program executes. Most type systems are flow-_insensitive_ - a variable declared as `T` stays `T` for its entire scope. Flow-sensitive systems, such as TypeScript's control flow narrowing, track how types evolve along different execution paths. What we add is applying this to _ownership_ - the availability of a value is part of its type, and that availability changes as the program flows through moves, drops, and conditional branches.

**Refinement types** allow types to be narrowed by predicates. When we write `if x { ... }`, we are refining the type of `x` from `Option<T>` to `Some<T>` (or to `None` in the else branch). This is a direct application of refinement typing - the conditional acts as a proof that the value is available, and the type system reflects that proof.

There are several parts of the system that _link_ values and their types during compilation - `Some<T>` depends on the `Option<T>` it was refined from, and as we will see in later posts, references depend on the values they point to. This is related to **dependent typing** in the limited sense that type validity depends on specific program values and ownership relationships. The system does not attempt full dependent typing in the Idris or Agda sense, but it does track value-to-type dependencies across function boundaries and through control flow.

**Abstract interpretation** provides the unifying framework. What the compiler does is interpret the program abstractly in the _availability domain_ - instead of computing actual values, it computes whether each variable is definitely available, definitely unavailable, or indeterminate. Branch joins widen the state, and conditionals narrow it. This is a standard abstract interpretation over a simple lattice: `T` (available) and `None` (unavailable) are the precise states, `Option<T>` is their join.

It is worth noting that availability is not the only domain the compiler interprets in. Later posts will introduce additional domains - each with its own lattice - interpreted over the same control flow structure. Dependency tracking, reference validity, and ownership of aggregates all follow the same abstract-interpretation approach.

## The rules so far

I will maintain a running list of the rules, invariants, and behaviors of the system as we go. Each post will add to it. This list may seem ad-hoc and chaotic because _there is no single syntactic trick that everything falls out of_ - there are several underlying principles playing together, which generate many small rules.

I warned you at the beginning that this is _not_ simple.

Here's the thing, though: you have to uphold these rules for safety _anyway_ - in C++ you do it in your head, in Rust you do it by fighting the borrow checker. All we do here is mechanically shift the responsibility from the developer to the compiler. Each rule is grounded in well-established theory - we just apply it in a way that doesn't require the developer to think about it.

0. Types are partitioned into _owned_ and _plain_. Owned types require destruction; plain types (integers, booleans, floats) do not
1. Each owned value has exactly one owner
2. Each owned value is dropped exactly once - when it or its owner goes out of scope, when it is explicitly dropped, or conditionally if its availability is indeterminate
3. A conditionally-dropped owned value is widened to `Option<T>`
4. `Option<T>` is itself an owned type when `T` is owned
5. `Option<T>` can be refined to `Some<T>` or `None` by a conditional check
6. `Some<T>` is non-owning - refinement does not transfer ownership
7. `Some<T>` obtained by refining `Option<T>` and the source `Option<T>` _depend_ on each other
8. Refinement is not sticky - it expires when control flow rejoins

## Conclusion

So this is the end of the beginning, and there's much, much more left to cover.

In the next post I will generalize this approach to aggregates such as records and arrays, and introduce references to allow sharing values without transferring ownership.
