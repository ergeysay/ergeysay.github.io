---
title: "Safe Made Easy Pt.2: Don't Fear the Ref"
date: 2026-06-03
categories: ["plt"]
description: "How to share values in a single-ownership system: compile-time dependency tracking that makes stale references unrepresentable and ownership cycles impossible."
url: /safe-made-easy-pt2.html
---

- [Intro](#intro)
- [Motivating example](#motivating-example)
- [The solution](#the-solution)
- [But what about self-references?](#but-what-about-self-references)
- [States of aggregation](#states-of-aggregation)
- [Shattering the cycle](#shattering-the-cycle)
- [Behind the scenes](#behind-the-scenes)
- [The rules so far](#the-rules-so-far)
- [Conclusion](#conclusion)

## Intro

So, in the [first installment of the series](https://ergeysay.github.io/safe-made-easy-pt1.html) I proposed a flow-sensitive typing solution to safety.

To recap, in this model each instance of an _owned_ type is guaranteed to be dropped only once.

Which brings the question: how do we _share access_ to an instance of an owned type?

- Option A is simple - we don't. There is no sharing, you can only move instances between owners. Solved. Except this would be far too strict - we will have to move instances all the time to do something interesting or useful. But I can imagine a language like that and it can be a viable solution, for some definition of.

- Option B is unrestricted sharing. There is an instance, we take a pointer to it, we don't know or care what is happening with the instance. If it's dropped and we still use it - oops, bad things happen but that's life. This is what C and C++ offer. C++'s references kinda try to sort this, but fall flat because the language doesn't really go to an extent of proving that the referenced object still exists while being accessible. For example, nothing stops you from doing this:

  ```c++
  struct Foo {
      int i;
  };

  Foo *foo = new Foo { .i = 123 };
  int& ref = foo->i;
  delete foo;
  printf("%d\n", ref);
  ```

  Apart from that, we don't know how many references there are - in other words, we have _unrestricted aliasing_.

- Option C is `shared_ptr` / `Rc` - which kind of is a natural evolution of the option B. It solves the issue "we don't know if the referenced object is still alive" with a tradeoff - now the references we have _guarantee_ the object is still alive by definition, and the object will live as long as it is reachable. Solved. Now we introduced shared ownership with all that entails - we don't know who owns a particular object (but we know how many owners it has).

- Option D is tracing GC, which I think can be seen as an evolution of option C to an extent? As in, in option C we trace dead objects incrementally, whereas a GC traces live objects. Again, shared ownership, just with a different set of tradeoffs.

But what if there was a way to check - statically, at a compile time - the _validity_ of a reference? Is it definitely valid - and then you can use it as you please, definitely invalid and you need to re-take it, or possibly invalid - in which case you have to confirm at runtime if the referenced object is still there or not?

This is what this post is about. Here, I will introduce a _dependency graph_ linking values at compile time, and the operations we can perform on it. I will also demonstrate how the same mechanism will allow us to detect and prevent ownership cycles at compile time and uphold the single acyclic ownership guarantee, freeing us from memory leaks.

It's also one of the most complex parts of the entire series, so buckle up, we're going for a ride.

## Motivating example

**An important note**: while I will still use pseudo-code to illustrate my points, I will try and gradually make it more and more _real_ starting with this post. So don't worry if you see something strange or unfamiliar - it all will come together at the end.

So, we start with the following problem: nothing can be shared.

```
var a: T = ...
var b = a // Moves from `a` unconditionally
```

We want to introduce a type that will allow us to _alias_ a value without taking ownership:

```
var a: T = ...
var ref: Ref<T> = &a
// Now we can use `ref` as a synonym for `a`
```

But what if `a` ceases to be available?

```
var a: T = ...
var ref: Ref<T> = &a
a.Destroy()
// What happens to `ref` here?
```

## The solution

At compile-time we track _which_ value `ref` is actually pointing to. If the original value is _invalidated_, the `ref` cannot be used anymore. Invalidation does not necessarily mean drop or `Destroy()` or something destructive - a _relocation_ of an object is inherently invalidating since all references pointing to it are stale after relocation.

```
var a: T = ...
var ref: Ref<T> = &a
a.Destroy()
io.Print("${ref}") // Compile-time error: cannot use invalid reference `ref`
```

Done. Unless you allocate another object and point the now-stale `ref` to that object, you cannot use it anymore.

```
var a: T = ...
var ref: Ref<T> = &a
a.Destroy()
var b: T = ...
ref = &b
io.Print("${ref}") // Works, `ref` is known to be valid at this point
```

But then you ask - wait, how would that work in presence of branching control flow? What happens if we _cannot_ statically, at compile-time, know _which_ object the reference is pointing to?

```
var a: T = ...
var b: T = ...

var ref = &a
if Math.Random() % 2 == 0 {
    ref = &b
}
a.Destroy()
// Is ref still valid here or not?
```

And that's actually a very good question! With a very simple answer. If we don't know which object a reference is depending on, it means it depends on **ALL** of them at the same time - **ALL** of them need to be valid for the reference to be valid.

The downside is that it is a _conservative_ approximation. In the example above, we infer that since `a` is not valid anymore, the `ref` cannot be used at all - even if it points to `b`. But by the same token, it is still safe - there is no way to use a reference that can potentially be stale.

But what if one of the potentially-pointed-to objects is conditionally invalidated?

```
var a: T = ...
var b: T = ...

var ref = &a
if Math.Random() % 2 == 0 {
    ref = &b
}
if Math.Random() % 2 == 0 {
    a.Destroy()
}
// Is `ref` still valid here or not?
```

Here, we don't know if `ref` points to `a` or to `b` or even if `a` is still valid. What a pickle. Fortunately, we also know _which_ of the dependencies are potentially invalidated. In this example, the second conditional statement transitions the type of `a` to `Option<T>`. All we have to do to prove if `ref` is still usable is to refine `a`:

```
var a: T = ...
var b: T = ...

var ref = &a
if Math.Random() % 2 == 0 {
    ref = &b
}
if Math.Random() % 2 == 0 {
    a.Destroy()
}
if a {
    // `ref` is valid
} else {
    // `ref` is unusable
}
// And here we don't have enough information to tell
```

References also have other interesting properties, but this post is long as it is, so I can only tease you a bit. One such property is that it is impossible to _drop_ or `Destroy()` via a reference - by definition, because references are non-owning - but it's absolutely sound to _move_ a valid instance into a reference, dropping the existing value it points to, because this will leave all references pointing to the same location valid. Wild, right?

## But what about self-references?

Consider:

```
class A {
    i: i32
    ref: Ref<i32>
}

var a: A = { .i = 123, .ref = &a.i }
var b: A = a
```

Here, we move `a` into `b`. Will `b.ref` work after the move?

For _boxed_ - heap-allocated instances with reference semantics, as seen in languages like C# - this is safe because the instance is not actually physically _moved_ anywhere, and `b.ref` will point to the same physical memory location as `a.ref` did.

But this approach is not general enough. For example, I would like my arrays to own the allocations of the instances - an array of instances should contain _instances themselves_, not _pointers to instances_ somewhere else on the heap. Also, custom allocators exist. So we need a better approach.

And the solution is relatively simple: when we detect that an instance containing a potential self-reference is moved, we invalidate the field containing that reference only, and we also prohibit any instance containing invalid references from participating in anything except field accesses. If an instance has an invalid reference field, it cannot, for example, be passed as a function argument, no methods can be called, but you still can read and write any members - including putting a valid reference in the invalidated field (but not reading from it).

My previous design was more convoluted and involved two kinds of reference types: `Ref<>` which could only point _outside_ of an instance, and `SelfRef<>` which could only point _inside_ and will get fixed up automatically after a move. The issue here is while this approach is simpler to implement than what I ended up with, it's also pretty useless in practice.

## States of aggregation

But then wild arrays appear, dynamic and mutable:

```
var arr = [1, 2, 3]
var ref: Ref<i32> = arr[0]!
arr.Clear()
// Now what
```

So the `arr` is provably live here, but `ref` is intuitively stale. This is why I used the word `invalidate` before - there are all sorts of events that can happen to a referenced value which will make references pointing to it _invalid_. In this particular case the only way to get your `ref` back is to take it again.

But what about the symmetric issue - what if we put references _into_ an array?

```
var a: T = ...
var b: T = ...
var arr: Array<Ref<T>> = [&a, &b]
arr.Shuffle()
a.Destroy()
var ref = arr[Math.Random() % 2]!
// Is `ref` valid here or not?
```

In this example, we don't know if `ref` is still valid because we don't know which array element is `a`. We also don't know which element `ref` points to. We know nothing.

Is `ref` useless? All is lost?

Not quite! Because arrays track the dependencies themselves. You see, nothing stops us from tracking dependencies of _types_ the same way we track dependencies of _values_. Each time a reference is pushed in an `Array<T>` we merge the dependency set of the pushed value into the element type `T`. Then `[]` returns `Ref<T>` dependent on **ALL** values any pushed references can potentially point to[^1].

By the same token, if you push a _self-referencing_ value to an array, **ALL** array elements will be considered self-referencing **AND** invalid - so you have to fix-up any self-references after you retrieve an object from the array. This is probably the most contentious point of this entire design; it remains to be seen how limiting it will be in practice.

[^1]: Well, not quite -- `[]` returns a `Result<Ref<T>>` which is why you see `!` near `[]` in my examples. But that's a story for another day.

Any other aggregates accumulate dependencies in a similar way, completely eliminating any possibility of use of a stale reference.

## Shattering the cycle

So, I just demonstrated how sharing - or _borrowing_ - works in a safe way that prevents _ever_ accessing a stale reference. We do this by using compile-time dependency tracking, which is the same exact mechanism we are going to use to prove that the ownership is not only _exclusive_, but _acyclic_, which is the requirement for memory-leak-freedom.

Let's start from the beginning. If you think of ownership as a directed graph from the owner to the owned values, there are several distinct topologies determining what invariants you can have.

- A general directed graph, where a node can have several incoming edges - owners - which then eventually form a loop: (A, B, C) -> D -> (A, B). This is an example of _circular_ ownership - A and D both own each other, as do B and D, therefore all three - A, B, and D - cannot be safely disposed of except if all are disposed together.

  This is why some languages relying on reference counting eventually arrived at the idea of using GC specifically to collect cycles - the easiest way to deal with this is to prove there are no incoming references to the cycle, then the entire cycle can be collected, and any form of tracing GC just sidesteps the issue altogether by collecting unreachable cycles (though you can still leak memory by forming _reachable_ cycles, but that's a story for another day).

- A directed _acyclic_ graph, where a node can have several incoming edges, but you somehow can guarantee absence of cycles. This mode _can_ guarantee leak-freedom - a node can be dropped when the last owner is dropped. I honestly have no idea if there are any languages exhibiting this mode.

- A tree - each node has exactly one incoming edge and arbitrary many outgoing edges, and there are no cycles. Each node has exactly one owner, with the singular root being the outermost stack frame. No memory leaks because no cycles are possible, but then the question becomes: how do we make this practical and how do we actually guarantee that no cycle can ever be formed?

In the previous chapter we introduced _dependencies_ and roughly outlined how to deal with cases where we lose information - by accounting for all possibilities.

Without further ado, we deal with ownership in exactly the same way: for each value, we track the ownership chain, widening it to include any possible owner if uncertain.

Mechanically, it's the same as the reference dependency tracking but in the opposite direction: when we track references, we track what this reference can point to - _incoming live edges_, live values this reference can possibly point to. For the ownership graph, we track _outgoing_ dependencies - what values this particular value can possibly own.

For example:

```
class T {
    owned: Option<T>
}

var a: T = { .owned = None }
a.owned = a
```

In this case, we know for certain that `a` is in its own ownership chain and immediately emit an error. Remember, `Option<T>` is an _owning_ type and will `Destroy()` (or drop in more common parlance) the contained instance of `T`, if any, when it is itself `Destroy()`ed.

```
class T {
    owned: Option<T>
}

var a: T = { .owned = None }

if Math.Random() % 2 == 0 {
    a.owned = a
}
```

Now, we have diverging control flow. We don't know for sure if a cycle will be formed, but it _could_ potentially form in a particular branch, so we ban the whole thing altogether and emit an error.

## Behind the scenes

This is yet another example of application of _abstract interpretation_, this time in the dependency set domain. When we lose information - for example, when we conditionally change a reference to point to a different object - we _widen_ the dependency set to accommodate _both_ potential possibilities. We also require the developer to prove that _all_ values from the dependency set are available.

However, there is no such thing as _narrowing_ in this case - there is no refinement that could say "reference R definitely refers to object A". The reason for this restriction is simple: as soon as aggregates come into the picture, resolving which array element a reference is pointing to becomes highly nontrivial and requires additional runtime logic. The dependency set containing all the possible objects a reference can point to is a strictly compile-time construct; it doesn't exist at runtime, unlike say `Option<T>` which is just a nullable pointer, and refinement of which translates to a null check at runtime.

By the same token we cannot narrow "value A does not own value B".

## The rules so far

0. Types are partitioned into _owned_ and _plain_. Owned types require destruction; plain types (integers, booleans, floats) do not
1. Each owned value has exactly one owner
2. Each owned value is dropped exactly once - when it or its owner goes out of scope, when it is explicitly dropped, or conditionally if its availability is indeterminate
3. A conditionally-dropped owned value is widened to `Option<T>`
4. `Option<T>` is itself an owned type when `T` is owned
5. `Option<T>` can be refined to `Some<T>` or `None` by a conditional check
6. `Some<T>` is non-owning - refinement does not transfer ownership
7. `Some<T>` obtained by refining `Option<T>` and the source `Option<T>` _depend_ on each other
8. Refinement is not sticky - it expires when control flow rejoins
9. `Ref<T>` is non-owning - referenced object cannot be dropped via a reference
10. `Ref<T>` allows mutations that preserve availability of the referenced object, including moving a new value into it
11. `Ref<T>` _depends_ on all values it can _potentially_ refer to
12. **ALL** dependencies of a `Ref<T>` should be valid in order for it to be valid
13. Aggregates such as `Array<T>` accumulate dependencies of any references pushed to it
14. Elements of aggregates such as `Array<T>` depend on **ALL** values from the accumulated dependency set
15. Ownership forms a tree - no value may transitively own itself
16. Any assignment that could form an ownership cycle is rejected, at arbitrary depth

## Conclusion

Today we figured out how to safely share values in a single-ownership system. Not so hard, huh?

We continue to methodically apply the idea from the previous post: if we lose information at runtime, we generalize, so that we preserve our understanding of the system.

So far, everything I did was _intra_-procedural - if you apply the rules above inside a single function, you will get a complete, sound model upholding guarantees I promised.

In the next post, I will explain how to generalize this analysis and make it _inter_-procedural and composable.

Stay tuned!
