---
title: "Make Me Heard"
date: 2026-06-28
categories: ["graphics"]
description: "Turning a short voice clip into a visualization: from an FFT spectrum to a data.json, a quick 2D preview, and a Blender armature driven by the sound."
url: /make-me-heard.html
---

- [The brief](#the-brief)
- [Recording the audio](#recording-the-audio)
- [From audio to data.json](#from-audio-to-datajson)
- [A quick 2D preview](#a-quick-2d-preview)
- [Driving a Blender armature](#driving-a-blender-armature)
- [The final visualization](#the-final-visualization)
- [Conclusion](#conclusion)

## The brief

My wife runs a communication coaching agency and needed a hero illustration for her new website. I thought it would be fun to do this myself, so here's the complete process behind it with [the live result](#the-final-visualization) at the very bottom.

The company is called makemeHEARD, so the obvious riff on that was something like an audio wave - immediately recognizable, very in tone. But how do we make it look _cool_?

I've looked through Google Images for `sound wave` and `sound wave render`. Most of these are of very sub-par quality: either very rough 2D, or 3D with some kind of "defect" like overlapping frequency bands - which quickly kills the illusion.

But some caught my attention - spindle-shaped 3D objects. Something like this would look nice if animated, I thought.

So, here's a short, but hopefully informative write-up on how to make one of these from your own audio. I won't go into each detail here, just outlining the workflow, assuming general familiarity with how audio visualizations usually work and a bit of knowledge of 3D techniques, so it's less of a tutorial and more of a recipe.

That said, let's dive in.

## Recording the audio

First of all, record the audio. Nothing fancy - just a short clip, in mono (one channel is enough for this), with any tool you have.

The exact contents of the audio matter less than the rhythm; I just repeated "make me heard" several times and that was it.

## From audio to data.json

Next, since we want it to be animated, we need to define a frame rate and get a frequency picture for each frame - how loud is each band at this particular moment in time?

There are many, many ways to generate a spectrum from audio; I didn't want to waste time, so I mostly replicated what Web Audio's `AnalyserNode` does - the windowing, dB magnitude and temporal smoothing - then added my own octave rebinning on top:

- FFT
- 8192-sample Blackman window, magnitude in dB
- 0.5 temporal smoothing so it doesn't jitter
- 1/8-octave rebinning of the linear FFT bins -> 70 values per frame
- normalize -85...-25 dB into [0, 1]

Easiest way to do that is to whip up a simple throwaway [Python script](/code/make-me-heard/generate.py) with Numpy.

Since we want to eventually drive a 3D visualization, we want our spectrum as _data_, not as _images_, though the latter still comes in handy as you will see in the next section. I settled for a simple JSON format: `{ frame: [70 band heights] }`.

## A quick 2D preview

Before investing in the 3D part, I wanted to draw it to see if the shape actually looks interesting and get some idea on how it will look animated, so another throwaway [Python script](/code/make-me-heard/preview_gif.py) generated a lovely black-and-white GIF. Each band from the data gets a vertical bar, mirrored across the centerline to get the classic waveform silhouette.

This is the moment when it's good to ask yourself - does this actually feel "lively", or "speaking", or is it flat and boring?

![The 2D preview, looping the spectrum](/img/make-me-heard/preview.gif "The 2D preview, looping the spectrum")

Looks fine to me, maybe even a bit too aggressive - but this is something I can tweak later. The "spindle" shape is clearly visible. Ready to move on.

## Driving a Blender armature

Now, I thought about just generating geometry, or maybe using something like metaballs, but then decided to just rig a cylinder in Blender - the closest thing we have to a "spindle" topology. Imagine a cylinder shape cut sideways with rings; each ring corresponds to a spectrum band; the _scale_ of each ring rigged to the amplitude of the band.

Sounds simple in theory, and even simpler in practice because Blender is awesome and we can automate the entire process: a third [Python script](/code/make-me-heard/blender_bones.py) generates an armature bone for each of the bands, keyframes with the scale for each frame, AND sets the weights of the cylinder vertices in one go.

Let's start with disposing of the default cube and adding an unassuming cylinder.

![Base cylinder](/img/make-me-heard/01-cylinder.png "A plain cylinder - its length is the wave's axis")

Lay it along X and scale. It takes a bit of trial and error to get the right cylinder size, because you want each band to be pronounced, but not too pronounced. The script also requires us to specify the size so that it will distribute the bones along the entire length of the cylinder.

![Rotated to lie along X](/img/make-me-heard/02-cylinder-rotated.png "Laid along X")

![Scaled to length](/img/make-me-heard/03-cylinder-scaled.png "Scaled to length (transforms applied)")

Subdivide along the length so the bones have rings to scale. I opted for 2 rings per band so that the shape between bands will also look smooth.

![Subdivided](/img/make-me-heard/04-cylinder-subdiv-1.png "Subdividing along the length")

![More loop cuts](/img/make-me-heard/05-cylinder-subdiv-2.png "two rings per band")

Then we select cylinder first, armature second, and the script does its magic. It will weight each vertex to its band by **X position** which results in slightly crisper deformation than if rigged with "Automatic Weights" (which over-blend and smear the wave a bit). The script will also set the keyframes to linear interpolation, which looks quite fine.

![Before the script - bare cylinder + armature](/img/make-me-heard/06-cylinder-before-script.png "Bare cylinder + armature, before the script")

![After - rigged and rippling with the voice](/img/make-me-heard/07-cylinder-animated.png "After the script - rigged and rippling with the voice")

At this step I noticed the model looked flat-shaded - this was not the look I was going for, so I went and flipped it to shade smooth, then exported to `.glb`.

![Shade smooth](/img/make-me-heard/08-cylinder-shade-smooth.png "Shade smooth, then export to .glb")

## The final visualization

<iframe src="/demos/wave/" width="100%" height="480" style="border:0;border-radius:8px;display:block" loading="lazy" title="Glass wave"></iframe>

This is our skinned cylinder rendered with a glass-like [shader](/code/make-me-heard/wave.js) using [ogl](https://github.com/oframe/ogl). Why not Three.js? I figured it will be overkill for something like this where the only thing I actually need is to render a GLTF model.

I've scaled down the animation playback speed 3x so it is not as aggressive as the GIF preview.

The renderer itself is simple, just two passes: a fullscreen backdrop with a procedural gradient, then cylinder on top.

The "glass" shader is also pretty simple, if a bit busy:

- Get _refraction_ contribution by sampling the backdrop at pixel offset by the surface normal
- Get _reflection_ contribution by sampling the backdrop by the reflection vector
- Blend the two by Fresnel
- Tint slightly with a half-Lambert term from the two coloured side lights
- Do a Fresnel rim lighting
- Add specular glints

The final colour is just `clamp(sum * exposure)` - opaque, no real transparency (the refraction _is_ the see-through). The shader also gives a very nice look similar to subsurface scattering.

One gotcha that shows up here: a bone scaled to 0 zeroes the transformed normal, which leads to `normalize(0)` generating NaNs, which show up as black pixels when a band reaches 0. The vertex shader falls back to the rest normal to avoid it.

## Conclusion

This was a fun little project! Making something like this is quite satisfying, and it was accepted as the hero illustration.

It should go without saying, but Blender is an amazing tool, especially if you know your way around Python.

If I were to do something like this again, I'd probably push the glass shader further - real screen-space refraction through a render target, maybe an environment to reflect.
