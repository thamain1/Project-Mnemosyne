We are focused on case 2 and more specifically on Case 3 as seen below.There are two images related to the AgenticOS and UI concept in the C:\Dev\Project-Mnemosyne\docs folder. I am not suggesting we redo the whole UI, but I greatly favor the Agentic OS and at least animating the node cloud we have in Mnemosyne for now. 

Chapter 1: Intro
0:00The most powerful AI model ever, Fable 5, is back, but we only have a week to play around with this thing before we lose it to API pricing. So, the question
0:099 secondsyou should be asking yourself is, what projects can I use Fable 5 on over the next seven days to get the most bang for
0:1717 secondsmy buck? How can I actually squeeze every ounce of juice out of this model?
0:2222 secondsWell, in this video, I'm going to help you out as I show you five different projects you can point Fable 5 at and get your money's worth. So with that,
Chapter 2: Case 1
0:3030 secondslet's hop in. So the first and arguably the best use case for Fable 5 is simply cloning software that already exists out in the real world. Probably software you pay for. Well, why are we paying for it?
0:4141 secondsWhy don't we just build a clone ourselves and customize it to our needs?
0:4444 secondsFable 5 is great at doing this. And in this demo, let's have it clone Whisper Flow. Ton of you probably use Whisper Flow or something like it. Well, why are
0:5252 secondswe paying for this? Furthermore, why are we giving our data to someone like Whisperflow and having that information that we speak into our microphone go to
1:001 minutesome cloud server? Why don't we just create a Whisper Flow that's purely local, runs on our machine, is faster, and again, we can customize to our
1:081 minute, 8 secondsheart's desire. Well, that's exactly what Fable 5 can do. Now, when we work on these big projects, something we do need to keep in mind is our usage
1:161 minute, 16 secondslimits. Up until July 7th, we can use Fable 5 with our max plans. However, we can only use up to 50% of the plan's
1:251 minute, 25 secondsweekly usage limit. So, we need to be smart about how we do this. We need to be smart about the sort of prompts we create. Doesn't make a lot of sense for me to just say, "Hey, Fable 5, go
1:331 minute, 33 secondsrecreate Whisper Flow." We can probably do better than that. In fact, what we can probably do is we could use something like The Research, aka dynamic
1:421 minute, 42 secondsworkflows, inside of Cloud Code, using a model like Opus 4.8, have it figure out a plan that actually makes sense. We
1:501 minute, 50 secondscould even use something like codeex to check that plan. And once we have a plan that makes sense, we hand it off to Fable 5. We do some of the upfront grunt
1:581 minute, 58 secondswork with Opus and let Fable 5 handle the rest. So that's exactly what we're going to do. So again, I'm on Opus 4.8.
2:042 minutes, 4 secondsI said for/dearch. I want to come up with a plan to clone WhisperFlow. I want you to do some deep research on how Whisperflow works, what we would need to
2:122 minutes, 12 secondsrecreate its base functionality on our computer. Furthermore, I'd like to recreate it locally. So I want it to be a local model running on Aloma that essentially does what Whisper Flow does.
2:202 minutes, 20 secondsSo we're going to run this. It's going to come back with a plan and if that plan makes sense to us, we're going to go ahead and hand it to Fable 5 and have it go to work. So it went ahead and
2:292 minutes, 29 secondsfinished the deep research and figured out, hey, this is what a Whisper Flow clone should look like. Here's how it would work on your computer and here's sort of the local architecture I'm thinking about. Now, what we want to do
2:382 minutes, 38 secondsis we want to take this whole report and we want to turn this into a prompt we can hand to Fable 5. And we can have Opus do that just fine. Ideally, we set
2:452 minutes, 45 secondsup this prompt. So, it makes sense if we do forward/goal. Remember, forward/goal is for longrunning agentic tasks, big
2:522 minutes, 52 secondsprojects, things that are perfect for fable 5. And with for/goal, we're saying, hey, this is what we want to do, and here's sort of the success criteria,
3:003 minutesand it's just going to keep working and working and working until it gets to your end state. So, perfect for things like this. So, it went ahead and created
3:083 minutes, 8 secondsthat prompt for me. So, I'm just going to go ahead and copy this thing. We're then going ahead and just switch the
3:143 minutes, 14 secondsmodel over to Fable 5. We pasted the prompt in there and we just let it go to work. And after
3:223 minutes, 22 secondssome back and forth, get the visuals working, we got this, which is my version of Whisper Flow, but entirely local. Nothing leaves my computer.
3:313 minutes, 31 secondsDoesn't have all the bells and whistles of Whisper Flow, but it does the basics.
3:343 minutes, 34 secondsIt listens to what's going on with my microphone. It transcribes it. It sends it down to the local AI model to clean it up. And when I'm done talking, it just populates it inside the text box.
3:453 minutes, 45 secondsLet's see what it gives us.
3:493 minutes, 49 secondsSo, hey, nothing leaves the computer. It doesn't have all the bells and whistles, etc., etc., etc. So, it just took everything I said and put it inside here. Now,
3:583 minutes, 58 secondsall the all that being said, is Whisper Flow clone the craziest thing ever for Fable 5? No, it can actually do a lot more than that. But it just sort of
4:054 minutes, 5 secondsdepends on what you want to clone. I think you sort of just use the template I gave you, which is do some deep research, figure out how that particular
4:124 minutes, 12 secondsapp actually works, figure out how you want to customize it, get your prompt in order, and then bring it to Fable 5. I definitely do not suggest using dynamic
4:204 minutes, 20 secondsworkflows with Fable 5 or you're just going to burn through all of your usage.
Chapter 3: Case 2
4:244 minutes, 24 secondsNow, let's move into use case number two, which is using Fable 5 to do a complete tearown and diagnosis of how you use Clawed Code and how you can
4:334 minutes, 33 secondsimprove. Now, I'm not talking about how you use Claw Code in terms of usage. I'm saying we're gonna have Fable 5 look across all your previous sessions. Take
4:404 minutes, 40 secondsa look at how you use Claude in terms of your skills, your automations, your tasks, and then figure out what you're doing right, what you're doing wrong,
4:494 minutes, 49 secondsand more importantly, what we can do to improve this. Does this mean changing our skills, creating new skills, adding new automations? So, this is essentially
4:574 minutes, 57 secondsdoing an audit of how you're using the tool itself. So, here's a look at the prompt. We're saying reflect on our past cloud code sessions to find the highest
5:045 minutes, 4 secondsleverage improvements to my setup. Use sub agents to pull raw signals from the transcripts. You cluster them across sessions and decide per cluster whether
5:125 minutes, 12 secondsit needs a new skill and automation, a fix or nothing. Write the candidates in this MD file. And we're saying, hey, at first it's just a diagnosis. I want to
5:215 minutes, 21 secondssee what it comes back with before it executes anything. Now, if you're wondering how I'm coming up with these prompts in this prompt structure, this is coming from Anthropic's official documentation when it comes to prompting
5:295 minutes, 29 secondsClaude Fable 5 because there are some nuances between how you want to use Fable and Mythos versus something like Opus. So, let's see what it comes back
5:375 minutes, 37 secondswith. So, Fable 5 ran through my last 39 sessions, and this is what it came up with. It broke it out into three different batches based on how much leverage it think gave me. and they
5:465 minutes, 46 secondsrange from creating new skills to setting certain skills as automations and some simple changes to things like
5:535 minutes, 53 secondsmycloud.md. So this is a really simple use case to improve your workflows within cloud code and it's something you'll get a lot more out of if you fall
6:016 minutes, 1 secondinto the power user side of the equation. So before we jump into the next use case just want to give you a quick word from today's sponsor which is
6:096 minutes, 9 secondsme. I just released the Claude Code Masterass not too long ago and it is the number one way to go from zero to AI dev, especially if you don't come from a
6:166 minutes, 16 secondstechnical background. We update this every single week and all the resources you see in today's video, including my cloud OS, can be found here inside of
6:246 minutes, 24 secondsChase AI Plus. There's a link to that in the pinned comment. So, definitely check us out if you are trying to get more serious about your AI journey. Now,
Chapter 4: Case 3
6:326 minutes, 32 secondslet's go into use case number three, which is building your own agentic OS.
6:356 minutes, 35 secondsWhat you see here is one I built with Fable 5, and this essentially acts as a custom wrapper over the top of Cloud
6:426 minutes, 42 secondsCode. What we see here is the visual side of it, but what's most important is what's going on under the hood. And it's a perfect follow on from use case number
6:506 minutes, 50 secondstwo, which is essentially codifying everything you do in your day-to-day, your week to week into skills and automations. But this gives us the
6:576 minutes, 57 secondsadditional advantages of certain visual metrics that we just can't get inside of the terminal. So for me, that includes things like content, right? what's been
7:047 minutes, 4 secondsgoing on with my content game across multiple platforms. I can see things like my different like morning reports and things of that nature. This is all
7:117 minutes, 11 secondslinked to Obsidian. And I have all of my mostus skills and automations over here on the right, which are just a click away. Now, again, I've done deep dives
7:197 minutes, 19 secondson this. I'm not going to turn this into a deep dive aentic OS video, but the most important part are all those skills and automations I'm talking about. You
7:267 minutes, 26 secondsneed to use Fable 5 to come up with the skills and automations that make sense for you. For me, that has to do with like research, content, things on my
7:347 minutes, 34 secondsagency side like sales and finance. All my individual tasks, Fable 5 turns into skills and turns them into automations, if that makes sense. And in certain
7:427 minutes, 42 secondscases, we apply loop engineering to those skills as well. But that really depends on the use case. But this sort of customized Aentic OS is pretty simple
7:517 minutes, 51 secondsfor Fable 5 to create. And one of the best parts about this is that if you're in the AI agency game, you can package this since it's essentially a web app that anyone can put on top of their
8:008 minutesclaude code and sell it. Or you can clone it and give this to teammates who aren't going to use the CLI or aren't
8:078 minutes, 7 secondsgoing to use the claude app because they can add whatever they want to this and you pretty much just wire up different skills and automations that you would
8:148 minutes, 14 secondsuse because it's just doing clawed headlessp under the hood which luckily for us isn't pulling from API prices
8:228 minutes, 22 secondsanymore since Anthropic walked that back a few weeks ago. Now use case number four comes directly from Enthropic itself and that is code review and debugging. If you have a complicated
Chapter 5: Case 4
8:308 minutes, 30 secondsproject, if you have a huge codebase, now is the time to take Fable 5 and point it at that codebase and see if you can figure out what code looks bad and
8:388 minutes, 38 secondswhat are actually bugs. And the prompt for this doesn't have to be complicated.
8:448 minutes, 44 secondsHey, so I want you to take a look at this codebase and I want you to do a full code review and also let me know about any bugs you find and it's going
8:528 minutes, 52 secondsto come back with whatever it finds. So after about 5 minutes it found 45 raw findings from four parallel reviewers dduped down to 24 and then it took those
9:009 minutes24 and it broke it down by severity and it gives us sort of an explanation of what's wrong at each step kind of like where the issue is and then it gives us
9:089 minutes, 8 secondsa specific fix priority and it's like hey do you want to go ahead and start working on these? Now the cool thing about this is I found all these things wrong in a codebase that isn't
9:179 minutes, 17 secondsnecessarily that complicated. There's things that are infinitely more complicated than what I'm doing here.
9:229 minutes, 22 secondsSo, if you are in that camp of someone who has something very complicated, there is no reason you should not be pointing Fable 5 at it and at least having it get eyes on on the work you've
9:309 minutes, 30 secondsalready done. Now, use case number five is what you see right here. It's having Fable 5 create whatever custom software you want. Something that is going to require a long horizon. This is a video game built in a browser running on 3JS.
Chapter 6: Case 5
9:429 minutes, 42 secondsAnd this looks wild. This is an insane accomplishment by Fable 5. You would not be able to create this using something
9:499 minutes, 49 secondslike Opus 4.8 unless you knew exactly what you were doing. This is again, this is all running on the browser. This isn't like a downloaded video game. This is all browser graphics and it's crazy.
9:599 minutes, 59 secondsNow, I wasn't the one who actually built that. This is an open- source project from Brapholk, who created this using Fable 5 the first time it came out. But I think this is a great case study for
10:0810 minutes, 8 secondsthe sort of things you can create. And the power here isn't just that Fable 5 built it. The power is that we can look
10:1610 minutes, 16 secondsat sort of how he created this from scratch. So the readme talks about the one document that they gave Fable 5 in
10:2410 minutes, 24 secondsorder to create this. So the human partially wrote one document which is this markdown file. And what is this?
10:3010 minutes, 30 secondsThis is a PRD. This is a product requirements document spelling out, hey, here's what we want to build, right? The visual target is a current gen Unreal
10:3910 minutes, 39 secondsEngine 5 showcase footage. And then it goes through sort of like the pillars of this application, the instructions, the constraint, the floors, etc., etc. Like
10:4710 minutes, 47 secondsI said, this was only partially written by the human. So, what you need to do if you're trying to create your own sort of software or game or whatever it is, some
10:5510 minutes, 55 secondssort of crazy project that only Fable 5 can build, you need to nail this down.
10:5810 minutes, 58 secondsYou need to nail down the PRD. Now, Fable 5 can help you, but we want to be very conscious of our usage. So, this is something Opus 4.8 can at least get it
11:0711 minutes, 7 secondsstarted with you, right? You should be able to create some sort of PRD with the specific instructions and with the specific requirements with Opus 4.8.
11:1511 minutes, 15 secondsAgain, use something like deep research to help you do that and then bring it to Fable 5. Essentially recreate what we did in the first use case. And after
11:2311 minutes, 23 secondsthat, you pretty much just hand it to Fable 5 and you let it execute it across long autonomous sessions exactly like the forward/goal scenario we did
11:3111 minutes, 31 secondsearlier. In this particular setup, Fable 5 wrote 21,000 lines of TypeScript across 90 plus commits to get what you just saw. So really cool stuff and
11:3911 minutes, 39 secondsthat's just a taste of what this model is able to build for you. So, those are the five table five use cases you need to try out this week. As always, let me
Chapter 7: Outro
11:4811 minutes, 48 secondsknow what you thought about this video in the comments. Make sure to check out Chase AI Plus if you want to get your hands on the Claude Code Masterass or my
11:5411 minutes, 54 secondsexact Claude OS setup. And besides that, I'll see you

Sync to video time