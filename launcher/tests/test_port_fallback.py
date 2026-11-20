import socket,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import mono_launcher as launcher

class PortFallbackTests(unittest.TestCase):
    def setUp(self):self.saved=(launcher.PORT,launcher.URL)
    def tearDown(self):launcher.PORT,launcher.URL=self.saved
    def test_taken_preferred_port_moves_to_the_next_free_one(self):
        holder=socket.socket();holder.bind((launcher.HOST,0));holder.listen();port=holder.getsockname()[1]
        try:
            launcher.PORT=port;launcher.URL=f'http://{launcher.HOST}:{port}'
            launcher.choose_port()
            self.assertNotEqual(launcher.PORT,port);self.assertTrue(launcher.PORT>port)
            self.assertEqual(launcher.URL,f'http://{launcher.HOST}:{launcher.PORT}')
        finally:holder.close()
    def test_free_preferred_port_is_kept(self):
        probe=socket.socket();probe.bind((launcher.HOST,0));port=probe.getsockname()[1];probe.close()
        launcher.PORT=port;launcher.choose_port();self.assertEqual(launcher.PORT,port)
    def test_a_hidden_browser_window_keeps_the_take_alive(self):
        # MONO now lives in the person's own browser, where launch flags cannot switch throttling off:
        # the take's heartbeat rides on the audio stream and a Web Lock keeps the page from freezing.
        source=(Path(launcher.__file__).resolve().parents[1]/'public'/'browser-microphone.js').read_text(encoding='utf-8')
        self.assertIn("message(runtime,data){runtime.ping?.();",source)
        self.assertIn("locks.request('mono-recording'",source)

if __name__=='__main__':unittest.main()
