---
layout: post
title:  "Optimising interpreters: fusion"
date:   2024-09-01 00:00:00 +0000
categories: plt
---

- [Preface](#preface)
- [The model task](#the-model-task)
- [World's simplest interpreter](#worlds-simplest-interpreter)
  - [Base node and constants](#base-node-and-constants)
  - [Arithmetic, comparison and conditional execution](#arithmetic-comparison-and-conditional-execution)
  - [Functions, calls, return statements and argument access](#functions-calls-return-statements-and-argument-access)
  - [What about the context?](#what-about-the-context)
  - [Calling it done](#calling-it-done)
- [Basic optimization](#basic-optimization)
- [Going deeper](#going-deeper)
- [Simplifying calls](#simplifying-calls)
- [What about clang?](#what-about-clang)
- [Drawing the rest of the eval](#drawing-the-rest-of-the-eval)
- [Conclusion](#conclusion)
- [Appendix: methodology of benchmarks](#appendix-methodology-of-benchmarks)

## Preface

Let me start with making an assumption that everyone has at some point in their life encountered a humble tree-walking interpreter. 

Between older implementations of popular programming languages, expression evaluators embedded in user-facing tools, and home-grown almost-complete-Lisp interpreters, these can still be found everywhere. 

This type of interpreter is considered to be the simplest and the slowest one. Oftentimes, you may see people rewriting their interpreters to bytecode-based ones just to get a bit more performance.

However, recently a project named [daScript](https://dascript.org/) (apparently [renamed to Daslang](https://borisbat.github.io/dascf-blog/2023/12/28/daslang-it-is/)) came into my attention. It is a very fast programming language, boasting one of the fastest interpreters I ever saw. 

What is more interesting is that this interpreter is tree-based, and yet it still manages to outperform bytecode-based interpreters with ease.

I got nerd-sniped and set out to investigate why it is so fast, and I found that it uses a pretty interesting optimisation technique that authors call _fusion_. As always, it turned out that the idea has already been explored and is also known as [supernodes](https://kar.kent.ac.uk/93936/) or, in the context of bytecode interpreters, as [superoperators](https://www2.cs.arizona.edu/~collberg/Teaching/553/2011/Resources/superops.pdf).

In this post, I will explain how it works by optimising a tiny model tree-walking interpreter step-by-step. There will be a lot of benchmarks, and you can find the [methodology](#appendix-methodology-of-benchmarks) at the end of this post.

**Disclaimer:** this post borrows _heavily_ from the daScript implementation. All ideas I will explain here originally belong to daScript authors, and any mistakes you may find are mine. That said, the implementation is completely new and does not include daScript source in any form.

## The model task

We are going to use the Fibonacci function. Our humble hero looks like this:
```cpp
uint32_t fib(uint32_t i) {
    if (i < 2) {
        return i;
    }
    return fib(i - 1) + fib(i - 2);
}
```

It may look simple, but it has a lot going on. Consider what an interpreter should implement to be able to evaluate it:
* Function calls
* Recursive function calls
* Argument accesses
* Two different arithmetic operators
* A comparison operator
* Conditional control flow

And this is what makes it a good model task: it is short and simple to implement in any language, and it is sufficiently complex at the same time to impose certain requirements on the environment it is being implemented in. 

With this model in mind, let's consider what exactly we will be measuring. We only have most basic evaluation primitives in play - there is no memory management, no type checks, just *raw evaluation*, so we will be measuring just that - performance of evaluation primitives. The benchmark will say nothing about the performance of each primitive used but will be able to give us a rough impression of which approach performs better.

I put all implementations in a single source file; calls to each implementation are guarded with a particular preprocessor directive in the source to avoid parsing command line flags in order to keep things simple.

Let's put the code above to the test and calculate `fib(42)`:
```shell
> cl_build.bat /DBASELINE oif.cpp
> hyperfine oif.exe

Benchmark 1: oif.exe
  Time (mean ± σ):     803.2 ms ±   4.7 ms    [User: 591.9 ms, System: 1.5 ms]
  Range (min … max):   797.1 ms … 814.2 ms    10 runs
```

## World's simplest interpreter

As I mentioned earlier, the venerable *tree-walking interpreter* is the simplest and arguably easiest to implement type of evaluator. 

A quick recap on how it works:
* The interpreter operates on a *tree* consisting of *nodes*, which may or may not have child nodes
* *Evaluating* a node yields a result
* If a node has any children, they have to be evaluated first before the parent node itself could be evaluated (thus the interpreter *walks* the *tree* recursively in depth-first order)
* Evaluating the root node yields the result of evaluation of the entire program

In the scope of this post, I will assume the following:
* There is no type checking during evaluation
* There is no memory management
* There are no other extraneous checks
* There is only one supported type, unsigned 32-bit integer (`uint32_t`)

Let's imagine what our `fib()` function would look like if implemented in such an interpreter:
```cpp
uint32_t fib(uint32_t n) {
    Context ctx;

    Function* function = new Function();

    function->init({
        new IfNode(
            new LessNode(new ArgNode(), new ConstNode(2)),
            new ReturnNode(new ArgNode())),
        new ReturnNode(
            new AddNode(
                new CallNode(function,
                    new SubNode(new ArgNode(), new ConstNode(1))),
                new CallNode(function,
                    new SubNode(new ArgNode(), new ConstNode(2)))))
    });

    CallNode* call = new CallNode(function, new ConstNode(n));

    uint32_t result = call->eval(&ctx);

    delete function;
    delete call;

    return result;
}
```

This is an exact mapping from our C++ implementation to our imaginary tree-walking interpreter: it implements the same operations our C++ implementation does, and performs them in the same order.

Now, let's try to actually make it work.

### Base node and constants

The very first thing we will do is to define the basic shape of a node:
```cpp
struct Node {
    virtual ~Node() {}

    virtual uint32_t eval(Context* ctx) { return 0; }
};
```

There's really not that much to it. It's just a class with a single virtual method `eval()` that accepts a mutable global interpreter state (also known as *context*) - more on that later. 

The `ConstNode` is not that interesting either - it just evaluates to the value it holds:
```cpp
struct ConstNode : Node {
    uint32_t value;

    ConstNode(uint32_t value) : value(value) {}

    uint32_t eval(Context* ctx) override {
        return value;
    }
};
```

### Arithmetic, comparison and conditional execution

These are a bit more complex since they have two child nodes, which should be recursively evaluated before the value of the node itself can be computed, but these are not terribly complicated either:
```cpp
struct AddNode : Node {
    Node* lhs;
    Node* rhs;

    AddNode(Node* lhs, Node* rhs) : lhs(lhs), rhs(rhs) {}

    ~AddNode() {
        delete lhs;
        delete rhs;
    }

    uint32_t eval(Context* ctx) override {
        return lhs->eval(ctx) + rhs->eval(ctx);
    }
};

struct SubNode : Node {
    Node* lhs;
    Node* rhs;

    SubNode(Node* lhs, Node* rhs) : lhs(lhs), rhs(rhs) {}

    ~SubNode() {
        delete lhs;
        delete rhs;
    }

    uint32_t eval(Context* ctx) override {
        return lhs->eval(ctx) - rhs->eval(ctx);
    }
};

struct LessNode : Node {
    Node* lhs;
    Node* rhs;

    ~LessNode() {
        delete lhs;
        delete rhs;
    }

    LessNode(Node* lhs, Node* rhs) : lhs(lhs), rhs(rhs) {}

    uint32_t eval(Context* ctx) override {
        return lhs->eval(ctx) < rhs->eval(ctx);
    }
};
```

Now that we have a comparison node, it would make sense to implement a conditional execution node to be able to use it:
```cpp
struct IfNode : Node {
    Node* condition;
    Node* body;

    IfNode(Node* condition, Node* body)
        : condition(condition), body(body) {}

    ~IfNode() {
        delete condition;
        delete body;
    }

    uint32_t eval(Context* ctx) override {
        if (condition->eval(ctx)) {
            body->eval(ctx);
        }

        return 0;
    }
};
```

I omitted implementation of the `else` branch, as it is not needed by our first implementation, but we will return to it just a bit later.

### Functions, calls, return statements and argument access

Next, let's implement function calls and related nodes. This is arguably the most complex part of the entire interpreter, but as you will see, it's actually pretty straightforward.

In our simple interpreter a function is just a list of nodes of a fixed length:
```cpp
struct Function {
    Node** body;
    uint32_t numNodes;

    Function() : body(0), numNodes(0) {}

    void init(std::initializer_list<Node*> body) {
        numNodes = (uint32_t) body.size();
        this->body = new Node * [numNodes];

        uint32_t i = 0;

        for (Node* statement : body) {
            this->body[i++] = statement;
        }
    }

    ~Function() {
        for (uint32_t i = 0; i < numNodes; i++) {
            delete body[i];
        }
        delete[] body;
    }
};
```

As you can see, a function itself is not a node, and as such cannot be evaluated. Instead, to actually evaluate it we will use a different node representing a function *call*:
```cpp
struct CallNode : Node {
    Function* function;
    Node* arg;

    CallNode(Function* function, Node* arg)
        : function(function), arg(arg) {}

    ~CallNode() {
        delete arg;
    }

    uint32_t eval(Context* ctx) override {
        if (ctx->stackTop == ctx->kStackSize - 1) {
            return 0;
        }

        ctx->stack[ctx->stackTop] = arg->eval(ctx);
        ctx->stackTop += 1;

        for (uint32_t i = 0, end_i = function->numNodes; i < end_i; i++) {
            function->body[i]->eval(ctx);
            if (ctx->stopForReturn) {
                break;
            }
        }

        ctx->stopForReturn = false;
        ctx->stackTop -= 1;

        return ctx->returnValue;
    }
};
```

Let's unpack what is happening here. 

A `CallNode` represents a unary function call, that is, a call of a function that only takes a single argument. This argument is evaluated and put on the stack in order for us to be able to access it later when evaluating the function body. Use of the stack will also allow us to create recursive functions.

To evaluate a function, we just iterate over the nodes of the function's body and evaluate them sequentially. That would be pretty much it, except we also need to support the return statement and ability to return values from the function.

In order to do that, we need two pieces of state: 
* a flag which indicates that the return statement has been encountered and we need to stop the evaluation and return control to the caller, and
* a field that holds the value that we should return. 
  
We reset the former before exiting to ensure that the subsequent function calls will not return immediately, and we use the latter as the actual result of the evaluation of the call.

Let's implement the `ReturnNode`:
```cpp
struct ReturnNode : Node {
    Node* rhs;

    ReturnNode(Node* rhs) : rhs(rhs) {}

    ~ReturnNode() {
        delete rhs;
    }

    uint32_t eval(Context* ctx) override {
        ctx->returnValue = rhs->eval(ctx);
        ctx->stopForReturn = true;

        // Since we pass the result in the ctx->returnValue field,
        // we don't need to return anything here
        return 0;
    }
};
```

It evaluates the right-hand-side node, puts the result into the context, and signals that a return statement has been encountered.

Last, but not least, we need to implement a way to access function arguments:
```cpp
struct ArgNode : Node {
    ArgNode() {}

    uint32_t eval(Context* ctx) override {
        return ctx->stack[ctx->stackTop - 1];
    }
};
```

`ArgNode` just returns the topmost value on the stack. This is enough since we only deal with unary functions; it would be just a tad more complicated if we were to support multiple arguments.

### What about the context?

Now that we know which state we need to be available for all nodes, we can put it all in a simple, neat struct.
```cpp
struct Context {
    const uint32_t kStackSize = 4096;
    bool stopForReturn;
    uint32_t returnValue;
    uint32_t* stack;
    uint32_t stackTop;

    Context() 
        : stopForReturn(false), returnValue(0), stack(new uint32_t[kStackSize]), stackTop(0) {}

    ~Context() {
        delete[] stack;
    }
};
```

### Calling it done

Let's take a look at our function once again:
```cpp
uint32_t fib(uint32_t n) {
    Context ctx;

    Function* function = new Function();

    function->init({
        new IfNode(
            new LessNode(new ArgNode(), new ConstNode(2)),
            new ReturnNode(new ArgNode())),
        new ReturnNode(
            new AddNode(
                new CallNode(function,
                    new SubNode(new ArgNode(), new ConstNode(1))),
                new CallNode(function,
                    new SubNode(new ArgNode(), new ConstNode(2)))))
    });

    CallNode* call = new CallNode(function, new ConstNode(n));

    uint32_t result = call->eval(&ctx);

    delete function;
    delete call;

    return result;
}
```

Now that we know how exactly each node is implemented, it all starts to make sense. There is only one thing to point out: the instantiation and initialization of the function are split into two parts in order for us to be able to refer to the function from inside of its body.

**Congratulations!** We have just implemented the simplest possible interpreter that can actually compute the value of the Fibonacci function. 

It is more or less the same as tree-walking interpreter straight from a CS course or one of the "building a Lisp" books:
* We have some kind of a data structure representing an AST node
* We have polymorphic dispatch that allows us to evaluate different kinds of nodes in different ways
* We can recursively evaluate an AST tree to compute a single value, the result of evaluation
* Our implementation is powerful enough to evaluate recursive functions

Now, let's see how it performs:
```shell
> cl_build.bat /DSIMPLEST oif.cpp
> hyperfine oif.exe

Benchmark 1: oif.exe
  Time (mean ± σ):     13.570 s ±  1.474 s    [User: 10.661 s, System: 0.025 s]
  Range (min … max):   11.847 s … 16.103 s    10 runs
```

...Huh. It's an _order of magnitude_ slower than the baseline implementation. As expected, even the simplest tree-walking interpreter is quite slow compared to equivalent C++ code. 

But don't worry, it will get better.

## Basic optimization

While this code looks like an absolute minimal implementation, there are still ways to make it even smaller. One way to do this would be to merge, or *fuse*, our small nodes into larger and more specialised nodes to reduce overhead introduced by virtual function calls, among other things.

Good candidates to fuse would be nodes that take constant arguments. In our case, that would be `LessNode` and `SubNode`. Let's implement fused versions:

```cpp
struct LessConstNode : Node {
    Node* lhs;
    uint32_t constant;

    LessConstNode(Node* lhs, uint32_t constant) 
        : lhs(lhs), constant(constant) {}

    ~LessConstNode() {
        delete lhs;
    }

    uint32_t eval(Context* ctx) {
        return lhs->eval(ctx) < constant;
    }
};

struct SubConstNode : Node {
    Node* lhs;
    uint32_t constant;

    SubConstNode(Node* lhs, uint32_t constant) 
        : lhs(lhs), constant(constant) {}

    ~SubConstNode() {
        delete lhs;
    }

    uint32_t eval(Context* ctx) {
        return lhs->eval(ctx) - constant;
    }
};
```

And update our function to use these nodes:
```cpp
uint32_t fib(uint32_t n) {
    Context ctx;

    Function* function = new Function();

    function->init({
        new IfNode(
            new LessConstNode(new ArgNode(), 2),
            new ReturnNode(new ArgNode())),
        new ReturnNode(
            new AddNode(
                new CallNode(function,
                    new SubConstNode(new ArgNode(), 1)),
                new CallNode(function,
                    new SubConstNode(new ArgNode(), 2))))
        });

    CallNode* call = new CallNode(function, new ConstNode(n));

    uint32_t result = call->eval(&ctx);

    delete function;
    delete call;

    return result;
}
```

That's it, on to benchmarking:
```shell
> cl_build.bat /DSIMPLE_FUSION oif.cpp
> hyperfine oif.exe

Benchmark 1: oif.exe
  Time (mean ± σ):      7.754 s ±  0.052 s    [User: 5.189 s, System: 0.009 s]
  Range (min … max):    7.703 s …  7.874 s    10 runs
```

Implementing this simple optimization makes our interpreter almost **two times faster** than our initial implementation. 

## Going deeper

Continuing this line of thought, let's take it further. What else can we merge or remove? 

We can introduce new, even more specialised nodes - not just the *"less-than-constant"* node, but the *"argument-less-than-constant"* node, and a similar one for subtraction:
```cpp
struct LessArgConstNode : Node {
    uint32_t constant;

    LessArgConstNode(uint32_t constant) : constant(constant) {}

    uint32_t eval(Context* ctx) override {
        if (ctx->stackTop == 0) {
            return 0;
        }
        return ctx->stack[ctx->stack_top - 1] < constant;
    }
};

struct SubArgConstNode : Node {
    uint32_t constant;

    SubArgConstNode(uint32_t constant) : constant(constant) {}

    uint32_t eval(Context* ctx) override {
        if (ctx->stackTop == 0) {
            return 0;
        }
        return ctx->stack[ctx->stack_top - 1] - constant;
    }
};
```

And this is where we should stop and reconsider what we are doing.

As you can see, we copied the entire implementation of the `ArgNode` into these new node types, just like we did before for `ConstNode`. It may look innocent at this point; however, this is quite error-prone and will quickly become tedious as more fused node types are introduced.

Actually, there is a way to remove duplication. We will introduce a new method, `compute(Context* ctx)`, and make sure it is always inlined. We will also express our `eval(Context* ctx)` method in terms of `compute(Context* ctx)`. This way we will always have a single implementation for a single node type, which can then be embedded in any other node.

Strictly speaking, we don't want to do this for all nodes (and it barely makes sense to do this for `ConstNode`), but I will still do it this way for the sake of consistency.

One more thing to mention before we proceed is that `compute(Context* ctx)` is non-virtual. This means that we can only use it when we know the exact type of the node on which we call it. In case of more generic nodes, we should still use `eval(Context* ctx)`.

This is what updated versions of the nodes look like:
```cpp
#if defined(__clang__)
#define FORCEINLINE __attribute__((always_inline))
#elif defined(_MSC_VER) // clang defines _MSC_VER on Windows for some reason
#define FORCEINLINE __forceinline 
#endif

struct ConstNode : Node {
    uint32_t value;

    ConstNode(uint32_t value) : value(value) {}

    uint32_t eval(Context* ctx) override {
        return compute(ctx);
    }

    uint32_t FORCEINLINE compute(Context* ctx) {
        return value;
    }
};

struct ArgNode : Node {
    ArgNode() {}

    uint32_t eval(Context* ctx) override {
        return compute(ctx);
    }

    uint32_t FORCEINLINE compute(Context* ctx) {
        if (ctx->stackTop == 0) {
            return 0;
        }
        return ctx->stack[ctx->stackTop - 1];
    }
};

struct LessArgConstNode : Node {
    ArgNode* lhs;
    ConstNode* rhs;

    LessArgConstNode(ArgNode* lhs, ConstNode* rhs) : lhs(lhs), rhs(rhs) {}

    uint32_t eval(Context* ctx) override {
        return compute(ctx);
    }

    uint32_t FORCEINLINE compute(Context* ctx) {
        return lhs->compute(ctx) < rhs->compute(ctx);
    }
};

struct SubArgConstNode : Node {
    ArgNode* lhs;
    ConstNode* rhs;

    SubArgConstNode(ArgNode* lhs, ConstNode* rhs) : lhs(lhs), rhs(rhs) {}

    uint32_t eval(Context* ctx) {
        return compute(ctx);
    }

    uint32_t FORCEINLINE compute(Context* ctx) {
        return lhs->compute(ctx) - rhs->compute(ctx);
    }
};
```

With these our Fibonacci function becomes:
```cpp
uint32_t fib(uint32_t n) {
    Context ctx;

    Function* function = new Function();

    function->init({
        new IfNode(
            new LessArgConstNode(new ArgNode(), new ConstNode(2)),
            new ReturnNode(new ArgNode())),
        new ReturnNode(
            new AddNode(
                new CallNode(function, new SubArgConstNode(new ArgNode(), new ConstNode(1))),
                new CallNode(function, new SubArgConstNode(new ArgNode(), new ConstNode(2)))))
        });

    CallNode* call = new CallNode(function, new ConstNode(n));

    uint32_t result = call->eval(&ctx);

    delete function;
    delete call;

    return result;
}
```

What's great about this is that not only did we get rid of the code duplication and associated pitfalls, but we also gained the ability to easily generate new fused node types (for example, with macros) and we paid no additional performance cost for this.

And we also gained a bit of performance:
```shell
> cl_build.bat /DBETTER_FUSION oif.cpp
> hyperfine oif.exe

Benchmark 1: oif.exe
  Time (mean ± σ):      6.413 s ±  0.024 s    [User: 4.452 s, System: 0.008 s]
  Range (min … max):    6.364 s …  6.452 s    10 runs
```

This shaves another second and a half, nice. But we still can do better.

## Simplifying calls

Let's take a look at our Fibonacci function again and figure out what else we can do. 

Going from the top of the function, the first thing we see is a `Function` wrapper. We only need it in order to be able to evaluate several nodes sequentially, and, more importantly, to be able to refer to the function from its body to perform recursive calls. However, all the evaluation logic belongs to `CallNode`, meaning that we probably can do without this wrapper.

In order to remove it, we will need to do the following:
* Update `CallNode` to be able to accept any `Node` as callable instead of a `Function` pointer
* Add ability to use `else` branches to the `IfNode`

While we are at it, we can also remove one `ReturnNode` instance by allowing the `IfNode` to return evaluation results of it branches.

I will implement new versions of the nodes as separate classes so that we will be able to see the old and new implementations side-by-side:
```cpp
struct CallAnyNode : Node {
    Node* function;
    Node* arg;

    CallAnyNode(Node* function, Node* arg) 
        : function(function), arg(arg) {}

    ~CallAnyNode() {
        delete arg;
    }

    uint32_t eval(Context* ctx) override {
        if (ctx->stackTop == ctx->kStackSize - 1) {
            return 0;
        }

        ctx->stack[ctx->stackTop] = arg->eval(ctx);
        ctx->stackTop += 1;

        uint32_t result = function->eval(ctx);

        ctx->stopForReturn = false;
        ctx->stackTop -= 1;

        return result;
    }
};

struct IfElseNode : Node {
    Node* condition;
    Node* ifBody;
    Node* elseBody;

    IfElseNode(Node* condition, Node* ifBody, Node* elseBody)
        : condition(condition), ifBody(ifBody), elseBody(elseBody) {}

    ~IfElseNode() {
        delete condition;
        delete ifBody;
        delete elseBody;
    }

    uint32_t eval(Context* ctx) override {
        if (condition->eval(ctx)) {
            return ifBody->eval(ctx);
        }
        else {
            return elseBody->eval(ctx);
        }
    }
};
```

With these, our function now looks like this:
```cpp
uint32_t fib(uint32_t n) {
    using BetterFusion::ArgNode;
    using BetterFusion::ConstNode;
    
    Context ctx;

    IfElseNode function(0, 0, 0);

    function.condition = new LessArgConstNode(new ArgNode(), new ConstNode(2));
    function.ifBody = new ArgNode();
    function.elseBody = new AddNode(
        new CallAnyNode(&function, new SubArgConstNode(new ArgNode(), new ConstNode(1))),
        new CallAnyNode(&function, new SubArgConstNode(new ArgNode(), new ConstNode(2))));

    CallAnyNode call(&function, new ConstNode(n));

    uint32_t result = call.eval(&ctx);

    return result;
}
```

While our first interpreter was a 1-1 mapping from the C++ source code, this one resembles the actual _compiled_ code - probably, at the very least at one of the stages. Which should give you intuition on what is actually happening here: we are doing the job of an optimising compiler manually and observe effects of optimisations first-hand.

What about the timings?
```shell
> cl_build.bat /DSIMPLIFY_CALLS oif.cpp
> hyperfine oif.exe

Benchmark 1: oif.exe
  Time (mean ± σ):      4.528 s ±  0.014 s    [User: 3.470 s, System: 0.006 s]
  Range (min … max):    4.498 s …  4.551 s    10 runs
```

And another two seconds gone. 

This will be the last version of the interpreter within the scope of this post. We went from 13.5s to 4.5s - the final version is **3 times faster** than our initial implementation and _only_ 5.64 times slower than the baseline C++ version.

To put things in perspective, let's add some _real_ interpreter results:
```shell
> node --version
v18.18.0

> hyperfine "node fib.js"
Benchmark 1: node fib.js
  Time (mean ± σ):      1.746 s ±  0.050 s    [User: 0.823 s, System: 0.007 s]
  Range (min … max):    1.694 s …  1.854 s    10 runs

> python --version
Python 3.10.4

> hyperfine "python fib.py"
Benchmark 1: python fib.py
  Time (mean ± σ):     35.415 s ±  0.697 s    [User: 18.959 s, System: 0.020 s]
  Range (min … max):   34.892 s … 37.312 s    10 runs

> ruby --version
ruby 3.2.2 (2023-03-30 revision e51014f9c0) [x64-mingw-ucrt]

> hyperfine "ruby fib.rb"
Benchmark 1: ruby fib.rb
  Time (mean ± σ):     12.796 s ±  0.201 s    [User: 6.513 s, System: 0.021 s]
  Range (min … max):   12.637 s … 13.317 s    10 runs

> luajit -v
LuaJIT 2.0.4 -- Copyright (C) 2005-2015 Mike Pall. http://luajit.org/

> hyperfine "luajit fib.lua"
Benchmark 1: luajit fib.lua
  Time (mean ± σ):      1.097 s ±  0.011 s    [User: 0.713 s, System: 0.001 s]
  Range (min … max):    1.082 s …  1.110 s    10 runs

> hyperfine "luajit -joff fib.lua"
Benchmark 1: luajit -joff fib.lua
  Time (mean ± σ):      7.966 s ±  0.029 s    [User: 4.146 s, System: 0.002 s]
  Range (min … max):    7.915 s …  8.005 s    10 runs
```

Some thoughts on these results:
* Both JITs leave everything else in the dust, with LuaJIT 2 being 1.7x faster than V8
* As expected, _real_ interpreters are much, much slower than our toy interpreter
* But I did not expect Ruby to be almost 3 times faster than Python!
* As a pleasant surprise, our toy interpreter manages to hold its own against LuaJIT in interpreter mode

## What about clang?

Honestly, I rarely use clang due to a force of habit, so imagine my surprise when I saw this:

```shell
> clang++ --version
clang version 17.0.6
Target: x86_64-pc-windows-msvc
Thread model: posix
InstalledDir: D:\Tools\LLVM\bin

> clang++ -O3 -ffast-math -DBASELINE oif.cpp -o oif-clang.exe
> hyperfine oif-clang.exe
Benchmark 1: oif-clang.exe
  Time (mean ± σ):     503.4 ms ±   6.8 ms    [User: 315.3 ms, System: 3.0 ms]
  Range (min … max):   494.9 ms … 514.0 ms    10 runs

> clang++ -Ofast -ffast-math -DSIMPLEST oif.cpp -o oif-clang.exe
> hyperfine oif-clang.exe
Benchmark 1: oif-clang.exe
  Time (mean ± σ):      8.604 s ±  0.072 s    [User: 4.393 s, System: 0.003 s]
  Range (min … max):    8.476 s …  8.744 s    10 runs

> clang++ -O3 -ffast-math -DSIMPLE_FUSION oif.cpp -o oif-clang.exe
> hyperfine oif-clang.exe
Benchmark 1: oif-clang.exe
  Time (mean ± σ):      7.050 s ±  0.045 s    [User: 3.069 s, System: 0.005 s]
  Range (min … max):    6.991 s …  7.147 s    10 runs

> clang++ -O3 -ffast-math -DBETTER_FUSION oif.cpp -o oif-clang.exe
> hyperfine oif-clang.exe
Benchmark 1: oif-clang.exe
  Time (mean ± σ):      5.434 s ±  0.015 s    [User: 2.588 s, System: 0.004 s]
  Range (min … max):    5.418 s …  5.468 s    10 runs

> clang++ -O3 -ffast-math -DSIMPLIFY_CALLS oif.cpp -o oif-clang.exe
> hyperfine oif-clang.exe
Benchmark 1: oif-clang.exe
  Time (mean ± σ):      5.012 s ±  0.033 s    [User: 2.391 s, System: 0.003 s]
  Range (min … max):    4.968 s …  5.074 s    10 runs
```

I am not sure what to make of this, except that I certainly did not expect these results. The baseline and the first, unoptimised version of the interpreter are a bit faster, but all of the optimisations have far less of an effect. I _definitely_ need to dig into this, but this post is already long as it is.  

## Drawing the rest of the eval

I handwaved away a lot of the important parts of a _real_ interpreter at the very beginning of this post, so let's take a step back.

First and foremost, the optimised representation is more like a bytecode - you probably should not attempt to parse directly into it. Instead, you will need an optimising pass (or rather _optimising passes_) that will transform your AST into this representation. Just like an optimising compiler would do.

You also want to be able to work with different types of data, and you want to minimise conversions between these types. _Anything_ not strictly related to evaluation - any type checks, conversions, and allocations - will inevitably affect performance.

But you will also need to perform type-checking somewhere, just not at the hot path. This suggests that this approach is best suited for _statically typed_ languages; however, you probably can do something like a tracing JIT where you figure out types for a subtree dynamically during runtime, generate an optimised representation on the fly and use guards to make sure that the types were not changed during execution.

Next, in a real interpreter, you would probably like to call functions with more than one argument. And you _will_ need a function wrapper for functions that are not as simple as Fibonacci function. Passing arguments will also take time.

All in all, this post only covers a very tiny, very specific part of what an interpreter should do, but I hope it manages to explain how tree-walking interpreters can be made much faster and that it will still be useful to someone.

## Conclusion

Even something as simple as a tree-walking interpreter can sometimes be made even simpler for surprising results.

My thanks go to Anton Yudintsev and Boris Batkin for daScript, the implementation of which served as inspiration for this post. I should note that there is a whole bunch of tricks the daScript interpreter uses besides fusion, which I hope to explore in detail in posts to come.

You may find the entire source code for the interpreter [here](https://github.com/ergeysay/optimising-interpreters-fusion).

Thank you for staying with me until the very end! See you, and stay tuned!

## Appendix: methodology of benchmarks

I won't go into much detail on the perils of benchmarking in 2024, but know that there [are](https://github.com/google/benchmark/blob/1e96bb0ab5e758861f5bbbd4edbd0a8d9a2a7cae/docs/reducing_variance.md) [many](https://github.com/sharkdp/hyperfine/issues/239). Contrary to popular belief, implementing a benchmark that measures what you think it is measuring is a feat in and of itself and is a proper rabbit hole - far too deep than I wanted to take you today. Perhaps I will write another post on this topic sometime.

In the scope of this post, however, I have taken it easy. I used [hyperfine](https://github.com/sharkdp/hyperfine) and I tried to make sure that the load of our benchmark is heavy enough to overweigh any start-up costs of any interpreter we are going to use.

In this setup, the precise number of milliseconds doesn't really matter, just the _relative_ performance compared to a set baseline.

The code was compiled using MSVC 2022 cl 19.38.33130 with the following command line flags:
```shell
/permissive- /GS0 /GL /W3 /Gy /Zc:wchar_t /Zi /Gm- /O2 /sdl /Zc:inline /fp:fast /D "NDEBUG" /WX- /Zc:forScope /Gd /Oi /MD /FC /EHsc /nologo /Ot /Fp
```

I wrapped this thing in a .bat file for convenience, which you can find with the rest of the source.
