// 1. Click chest → request mic → load processor → fade to top-down chest
document.getElementById("iceChestClickable").addEventListener("click", () => {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      // Store stream globally
      sharedStream = stream;

      // Ensure audio context exists
      ensureAudioContext();

      // Load the AudioWorklet FIRST (critical for Safari/iPad)
      audioCtx.audioWorklet.addModule("looper/looper-processor.js").then(() => {
        // Create processor node
        processor = new AudioWorkletNode(audioCtx, "looper-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1
        });

        // Connect mic AFTER processor exists
        micSource = audioCtx.createMediaStreamSource(stream);
        micSource.connect(processor);

        // Set up processor message handling (defined in app.js)
        setupProcessorPort();

        // Now run your animation sequence
        console.log("Chest clicked — animation should start now");
        document.getElementById("storeScene").style.opacity = 0;

        setTimeout(() => {
          document.getElementById("storeScene").style.display = "none";
          document.getElementById("topDownChest").classList.remove("hidden");
        }, 600);
      });
    })
    .catch(() => {
      alert("Microphone access is required to use Icebox Looper.");
    });
});


// 2. Pull lever → open lid → reveal looper
document.getElementById("chestLever").addEventListener("click", () => {
  const lever = document.getElementById("chestLever");
  const lid = document.getElementById("chestLid");

  lever.classList.add("pulled");

  setTimeout(() => {
    lid.classList.add("open");
  }, 150);

  setTimeout(() => {
    document.getElementById("topDownChest").classList.add("hidden");
  }, 900);

  setTimeout(() => {
    document.getElementById("iceboxInterior").classList.remove("hidden");

    // Start looper visuals
    requestAnimationFrame(updateVisuals);

    // Fade out intro container
    document.getElementById("introContainer").style.opacity = 0;
    setTimeout(() => {
      document.getElementById("introContainer").style.display = "none";
    }, 600);
  }, 1500);
});
