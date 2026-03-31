const SUPABASE_URL = "https://bcardtccxcnktkkeszpp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjYXJkdGNjeGNua3Rra2VzenBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1NzU1NDIsImV4cCI6MjA4MDE1MTU0Mn0.xGxk81ThPGtyQgRCNoOxpvxsnXBUAzgmclrS0ru7g2Q";

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function check() {
    const { data, error } = await supabase.from('members').select('*').limit(1);
    console.log(JSON.stringify(data[0], null, 2));
}

check();
