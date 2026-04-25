let mediaRecorder;
let audioChunks = [];

async function uploadPDF() {
    const fileInput = document.getElementById('pdfFile');
    const status = document.getElementById('status');
    if (!fileInput.files[0]) return alert("Select a PDF first!");

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    status.innerText = "Processing PDF... Please wait.";
    const response = await fetch("/upload_pdf", { method: "POST", body: formData });
    const data = await response.json();
    status.innerText = data.message;
}

// Recording Logic
const recordBtn = document.getElementById('recordBtn');

recordBtn.onmousedown = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.start();
    document.getElementById('chatStatus').innerText = "Recording...";
};

recordBtn.onmouseup = async () => {
    mediaRecorder.stop();
    document.getElementById('chatStatus').innerText = "Thinking...";
    mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
        const formData = new FormData();
        formData.append("audio", audioBlob);

        const response = await fetch("/chat", { method: "POST", body: formData });
        const data = await response.json();
        
        document.getElementById('responseArea').innerHTML = `<strong>AI:</strong> ${data.reply}`;
        document.getElementById('chatStatus').innerText = "Ready";
        
        // Play AI Voice
        const audio = new Audio("data:audio/mp3;base64," + data.audio_base64);
        audio.play();
    };
};
async function startStreamingChat(audioBlob) {
    const formData = new FormData();
    formData.append("audio", audioBlob);

    const response = await fetch("/chat_stream", { method: "POST", body: formData });
    
    // Check if it's cached or streaming
    if (response.headers.get("content-type") === "application/json") {
        const data = await response.json();
        updateUI(data.reply); // Fast cache hit
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        fullText += chunk;
        document.getElementById("responseArea").innerText = fullText; // Live update
    }
}