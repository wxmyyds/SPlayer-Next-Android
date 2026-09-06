package com.wxmyyds.splayer.next;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeHttpPlugin.class);
        registerPlugin(LoginWebPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
