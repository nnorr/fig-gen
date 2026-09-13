// fig-gen test fixture (self-written): a user-style testbench for counter.sv.
`timescale 1ps/1ps
module tb_counter;
  logic clk = 1'b0;
  logic rst_n = 1'b0;
  logic en = 1'b0;
  logic [3:0] count;
  logic wrap;
  counter dut (.*);
  always #5000 clk = ~clk;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, tb_counter);
    repeat (2) @(posedge clk);
    rst_n <= #1 1'b1;
    @(posedge clk);
    en <= #1 1'b1;
    repeat (20) @(posedge clk);
    $finish;
  end
endmodule
